import {
  tvCapabilitiesSchema,
  tvSnapshotSchema,
  type TvApp,
  type TvButton,
  type TvCapabilities,
  type TvIdentity,
  type TvInput,
  type TvSnapshot,
  type TvTransport,
} from '@remote-webos-tv/contracts';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import LGTV from 'lgtv2';

import type {
  PairingRequest,
  PairingResult,
  WebOsAdapter,
} from './adapter.js';
import { toWebOsButton } from './buttons.js';
import { TvButtonSendError, TvPowerSendError, WebOsCleanupError, WebOsError } from './errors.js';
import type { ClientKeyStore } from './key-store.js';
import type {
  Lgtv2Client,
  Lgtv2ClientFactory,
  Lgtv2ClientOptions,
  Lgtv2SpecializedSocket,
} from './lgtv2-types.js';
import {
  parseApps,
  parseIdentity,
  parseInputs,
  parseMacAddresses,
  parseVolume,
} from './response-parsers.js';
import { sendWakeOnLan } from './wake-on-lan.js';

const uris = {
  systemInfo: 'ssap://system/getSystemInfo',
  softwareInfo: 'ssap://com.webos.service.update/getCurrentSWInformation',
  volume: 'ssap://audio/getVolume',
  apps: 'ssap://com.webos.applicationManager/listLaunchPoints',
  inputs: 'ssap://tv/getExternalInputList',
  network: 'ssap://com.webos.service.connectionmanager/getinfo',
  pointer: 'ssap://com.webos.service.networkinput/getPointerInputSocket',
  setVolume: 'ssap://audio/setVolume',
  launchApp: 'ssap://com.webos.applicationManager/launch',
  switchInput: 'ssap://tv/switchInput',
  insertText: 'ssap://com.webos.service.ime/insertText',
  notification: 'ssap://system.notifications/createToast',
  powerOff: 'ssap://system/turnOff',
} as const;

const webSocketOpenState = 1;

type Lgtv2Operation =
  | 'pair'
  | 'snapshot'
  | 'apps'
  | 'inputs'
  | 'pointer'
  | 'button'
  | 'set-volume'
  | 'launch-app'
  | 'switch-input'
  | 'text'
  | 'notification'
  | 'power-off'
  | 'wake'
  | 'disconnect';

export interface Lgtv2AdapterOptions {
  readonly host: string;
  readonly keyStore: ClientKeyStore;
  readonly requestTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly now: () => Date;
  /** Explicit setup may authorize PROMPT; saved-key reconnection must fail closed. */
  readonly allowPairingPrompt?: boolean;
}

interface Lgtv2AdapterDependencies {
  readonly createClient: Lgtv2ClientFactory;
  readonly wake: (
    macAddresses: readonly string[],
    signal: AbortSignal,
  ) => Promise<void>;
}

type MutableCapabilities = {
  -readonly [Capability in keyof TvCapabilities]: TvCapabilities[Capability];
};

const defaultDependencies: Lgtv2AdapterDependencies = {
  createClient: createLgtv2Client,
  wake: sendWakeOnLan,
};

export class Lgtv2Adapter implements WebOsAdapter {
  readonly #options: Lgtv2AdapterOptions;
  readonly #dependencies: Lgtv2AdapterDependencies;
  #client: Lgtv2Client | undefined;
  #pointerSocket: Lgtv2SpecializedSocket | undefined;
  #pointerAcquisition: { readonly client: Lgtv2Client; readonly promise: Promise<Lgtv2SpecializedSocket> } | undefined;
  #identity: TvIdentity | undefined;
  #capabilities: MutableCapabilities | undefined;
  #transport: TvTransport | undefined;
  #pairingPromise: Promise<PairingResult> | undefined;
  #cancelPairing: (() => void) | undefined;
  #disconnectPromise: Promise<void> | undefined;
  #pointerCleanupFailure: WebOsError | undefined;

  constructor(
    options: Lgtv2AdapterOptions,
    dependencies: Partial<Lgtv2AdapterDependencies> = defaultDependencies,
  ) {
    this.#options = options;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async pair(request: PairingRequest): Promise<PairingResult> {
    if (this.#pairingPromise) {
      throw new WebOsError('UNKNOWN', 'Pairing is already in progress');
    }
    if (request.host !== this.#options.host) {
      throw new WebOsError('UNKNOWN', 'Pairing host does not match adapter configuration');
    }

    const operation = this.#pair(request);
    this.#pairingPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.#pairingPromise === operation) {
        this.#pairingPromise = undefined;
      }
    }
  }

  async readSnapshot(signal: AbortSignal): Promise<TvSnapshot> {
    const client = this.#requireClient();
    const payload = await this.#execute(
      'snapshot',
      signal,
      () => client.request(uris.volume),
    );
    const volume = parseVolume(payload);

    return tvSnapshotSchema.parse({
      connection: 'available',
      identity: this.#identity,
      capabilities: this.#capabilities,
      transport: this.#transport,
      ...volume,
    });
  }

  async openPointerSocket(signal: AbortSignal): Promise<void> {
    await this.#getPointerSocket(signal);
  }

  async #getPointerSocket(
    signal: AbortSignal,
  ): Promise<Lgtv2SpecializedSocket> {
    const client = this.#requireClient();
    const pointerSocket = await this.#execute(
      'pointer',
      signal,
      () => {
        // lgtv2 caches only completed sockets. Keep one raw acquisition per
        // client across eager caller cancellation to prevent late cache overwrite.
        if (this.#pointerAcquisition?.client === client) return this.#pointerAcquisition.promise;
        const pending = client.getSocket(uris.pointer).then((socket) => {
          if (this.#client !== client) {
            // Only a stale client's socket is ours to close here; cancellation
            // alone must not close a cache shared with a later caller.
            try { socket.close(); }
            catch (cause) {
              this.#pointerCleanupFailure = new WebOsError('CONNECTION_LOST', 'Unable to close a stale pointer socket', { cause });
              throw this.#pointerCleanupFailure;
            }
            throw new WebOsError('CONNECTION_LOST', 'Pointer belongs to a replaced client');
          }
          return socket;
        });
        const acquisition = { client, promise: pending.finally(() => {
          if (this.#pointerAcquisition === acquisition) this.#pointerAcquisition = undefined;
        }) };
        this.#pointerAcquisition = acquisition;
        return acquisition.promise;
      },
    );
    throwIfAborted(signal);
    if (this.#client !== client) throw new WebOsError('CONNECTION_LOST', 'Pointer belongs to a replaced client');
    if (
      pointerSocket.ws &&
      pointerSocket.ws.readyState !== webSocketOpenState
    ) {
      throw new WebOsError(
        'CONNECTION_LOST',
        'Pointer socket is no longer open',
      );
    }
    this.#pointerSocket = pointerSocket;
    return pointerSocket;
  }

  async listApps(signal: AbortSignal): Promise<readonly TvApp[]> {
    const client = this.#requireClient();
    const payload = await this.#execute(
      'apps',
      signal,
      () => client.request(uris.apps),
    );
    return parseApps(payload);
  }

  async listInputs(signal: AbortSignal): Promise<readonly TvInput[]> {
    const client = this.#requireClient();
    const payload = await this.#execute(
      'inputs',
      signal,
      () => client.request(uris.inputs),
    );
    return parseInputs(payload);
  }

  async sendButton(button: TvButton, signal: AbortSignal): Promise<void> {
    let delivery: 'not_sent' | 'unknown' = 'not_sent';
    try {
      const pointerSocket = await this.#getPointerSocket(signal);
      const name = toWebOsButton(button);
      await this.#execute('button', signal, async () => {
        // No await between cancellation check and the transport boundary.
        throwIfAborted(signal);
        delivery = 'unknown';
        pointerSocket.send('button', { name });
      });
    } catch (cause) {
      const error = mapLgtv2Error(cause, 'button', true);
      throw new TvButtonSendError(error.code, delivery, error.message, { cause: error });
    }
  }

  async setVolume(volume: number, signal: AbortSignal): Promise<void> {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
      throw new WebOsError('UNKNOWN', 'Volume must be an integer from 0 to 100');
    }
    const client = this.#requireClient();
    await this.#execute(
      'set-volume',
      signal,
      () => client.request(uris.setVolume, { volume }),
    );
  }

  async launchApp(id: string, signal: AbortSignal): Promise<void> {
    const client = this.#requireClient();
    await this.#execute(
      'launch-app',
      signal,
      () => client.request(uris.launchApp, { id }),
    );
  }

  async switchInput(id: string, signal: AbortSignal): Promise<void> {
    const client = this.#requireClient();
    await this.#execute(
      'switch-input',
      signal,
      () => client.request(uris.switchInput, { inputId: id }),
    );
  }

  async insertText(text: string, signal: AbortSignal): Promise<void> {
    const client = this.#requireClient();
    await this.#execute(
      'text',
      signal,
      () => client.request(uris.insertText, { text, replace: 0 }),
    );
  }

  async createNotification(
    message: string,
    signal: AbortSignal,
  ): Promise<void> {
    const client = this.#requireClient();
    await this.#execute(
      'notification',
      signal,
      () => client.request(uris.notification, { message }),
    );
  }

  async powerOff(signal: AbortSignal): Promise<void> {
    let delivery: 'not_sent' | 'unknown' = 'not_sent';
    try {
      const client = this.#requireClient();
      await this.#execute('power-off', signal, () => {
        throwIfAborted(signal);
        delivery = 'unknown';
        return client.request(uris.powerOff);
      }, 'owner');
    } catch (cause) {
      const error = mapLgtv2Error(cause, 'power-off', true);
      throw new TvPowerSendError(error.code, delivery, error.message, { cause: error });
    }
  }

  async wake(
    macAddresses: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    let delivery: 'not_sent' | 'unknown' = 'not_sent';
    try {
      await this.#execute('wake', signal, () => {
        throwIfAborted(signal);
        delivery = 'unknown';
        return this.#dependencies.wake(macAddresses, signal);
      }, 'owner');
    } catch (cause) {
      // The actual UDP owner can prove a pre-send failure more precisely.
      if (cause instanceof TvPowerSendError) {
        const source = cause.cause instanceof WebOsCleanupError ? cause.cause.cause : cause.cause ?? cause;
        const error = mapLgtv2Error(source, 'wake', true);
        throw new TvPowerSendError(error.code, cause.delivery, error.message, { cause });
      }
      const error = mapLgtv2Error(cause, 'wake', true);
      throw new TvPowerSendError(error.code, delivery, error.message, { cause: error });
    }
  }

  async disconnect(): Promise<void> {
    this.#cancelPairing?.();
    await this.#disconnectClient();
  }

  async #pair(request: PairingRequest): Promise<PairingResult> {
    await this.#disconnectClient();
    throwIfAborted(request.signal);

    const loadedKey = request.clientKey ?? (await this.#options.keyStore.load());
    const initialKey = loadedKey && loadedKey.length > 0 ? loadedKey : undefined;
    let observedKey: string | undefined;
    let keySavePromise: Promise<void> | undefined;
    let transport: TvTransport = 'wss:3001';

    const clientOptions: Lgtv2ClientOptions = {
      host: this.#options.host,
      clientKey: initialKey ?? '',
      saveKey: (key, callback) => {
        observedKey = key;
        keySavePromise = this.#saveClientKey(key);
        keySavePromise.then(
          () => callback(),
          (error: Error) => callback(error),
        );
      },
      timeout: this.#options.requestTimeoutMs,
      handshakeTimeout: this.#options.handshakeTimeoutMs,
      reconnect: 0,
      verifyCert: 'lg',
      learnMac: false,
      macFile: disabledMacFile(),
    };

    let client: Lgtv2Client;
    try {
      client = this.#dependencies.createClient(clientOptions);
    } catch (cause) {
      throw mapLgtv2Error(cause, 'pair', initialKey !== undefined);
    }
    this.#client = client;

    return new Promise<PairingResult>((resolve, reject) => {
      let settled = false;
      let finishing = false;
      let failing = false;

      const removeControls = () => {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', abortPairing);
        if (this.#cancelPairing === cancelPairing) {
          this.#cancelPairing = undefined;
        }
      };

      const fail = (error: WebOsError) => {
        if (settled || failing) {
          return;
        }
        failing = true;
        removeControls();
        void this.#disconnectClient().then(
          () => {
            settled = true;
            reject(error);
          },
          (cleanupCause) => {
            settled = true;
            reject(withCleanupFailure(error, cleanupCause));
          },
        );
      };

      const cancelPairing = () => {
        fail(
          new WebOsError(
            'CONNECTION_LOST',
            'Pairing was cancelled before registration completed',
          ),
        );
      };
      const abortPairing = () => cancelPairing();

      const finish = async () => {
        if (settled || finishing || failing) {
          return;
        }
        finishing = true;
        try {
          await Promise.resolve();
          await keySavePromise;
          const clientKey = observedKey ?? initialKey;
          if (!clientKey) {
            throw new WebOsError(
              'INVALID_TV_RESPONSE',
              'Registered response did not provide a client key',
            );
          }

          const [systemInfo, softwareInfo, networkInfo] = await Promise.all([
            client.request(uris.systemInfo),
            client.request(uris.softwareInfo),
            client.request(uris.network),
          ]);
          const identity = parseIdentity(systemInfo, softwareInfo);
          const macAddresses = parseMacAddresses(networkInfo);
          const capabilities = createCapabilities(macAddresses.length > 0);

          if (failing || settled) {
            return;
          }
          this.#identity = identity;
          this.#capabilities = capabilities;
          this.#transport = transport;
          settled = true;
          removeControls();
          resolve({
            clientKey,
            identity,
            capabilities,
            transport,
            macAddresses,
          });
        } catch (cause) {
          fail(mapLgtv2Error(cause, 'pair', initialKey !== undefined));
        }
      };

      client.on('connecting', (url) => {
        if (url.startsWith('wss://')) {
          transport = 'wss:3001';
        } else if (url.startsWith('ws://')) {
          transport = 'ws:3000';
        } else {
          fail(
            new WebOsError(
              'INVALID_TV_RESPONSE',
              'lgtv2 selected an unsupported transport',
            ),
          );
        }
      });
      client.on('connect', () => {
        void finish();
      });
      client.on('prompt', () => {
        if (this.#options.allowPairingPrompt === false) {
          fail(new WebOsError('AUTHORIZATION_FAILED', 'Saved authorization requires a fresh pairing prompt'));
        }
      });
      client.on('error', (error) => {
        if (!settled) {
          fail(mapLgtv2Error(error, 'pair', initialKey !== undefined));
        }
      });
      client.on('close', () => {
        if (!settled) {
          fail(
            new WebOsError(
              'CONNECTION_LOST',
              'Connection closed before pairing completed',
            ),
          );
        }
      });

      const timer = setTimeout(() => {
        fail(
          new WebOsError(
            'PAIRING_TIMEOUT',
            'Pairing did not complete before the configured timeout',
          ),
        );
      }, this.#options.requestTimeoutMs);
      timer.unref();
      request.signal.addEventListener('abort', abortPairing, { once: true });
      this.#cancelPairing = cancelPairing;

      if (request.signal.aborted) {
        abortPairing();
      }
    });
  }

  async #saveClientKey(clientKey: string): Promise<void> {
    try {
      await this.#options.keyStore.save(clientKey);
    } catch (cause) {
      if (cause instanceof WebOsError) {
        throw cause;
      }
      throw new WebOsError(
        'KEY_STORE_WRITE_FAILED',
        'Unable to persist the registered client key',
        { cause },
      );
    }
  }

  #requireClient(): Lgtv2Client {
    if (!this.#client || !this.#client.connected) {
      throw new WebOsError('CONNECTION_LOST', 'webOS client is not connected');
    }
    return this.#client;
  }

  async #execute<T>(
    operation: Lgtv2Operation,
    signal: AbortSignal,
    start: () => Promise<T>,
    abortHandling: 'eager' | 'owner' = 'eager',
  ): Promise<T> {
    try {
      throwIfAborted(signal);
      const pending = start();
      return await (abortHandling === 'owner'
        ? pending
        : withAbort(pending, signal));
    } catch (cause) {
      const error = mapLgtv2Error(cause, operation, true);
      const capability = capabilityForOperation(operation);
      if (
        capability &&
        this.#capabilities &&
        isUnsupportedCapabilityError(error)
      ) {
        this.#capabilities[capability] = false;
      }
      throw error;
    }
  }

  #disconnectClient(): Promise<void> {
    if (this.#disconnectPromise) {
      return this.#disconnectPromise;
    }

    const client = this.#client;
    const pointerSocket = this.#pointerSocket;
    this.#client = undefined;
    this.#pointerSocket = undefined;
    this.#identity = undefined;
    this.#capabilities = undefined;
    this.#transport = undefined;

    const operation = (async () => {
      pointerSocket?.close();
      if (client) {
        await client.disconnect();
      }
      if (this.#pointerCleanupFailure) throw this.#pointerCleanupFailure;
    })();
    let trackedOperation: Promise<void>;
    trackedOperation = operation.finally(() => {
      if (this.#disconnectPromise === trackedOperation) {
        this.#disconnectPromise = undefined;
      }
    });
    this.#disconnectPromise = trackedOperation;
    return this.#disconnectPromise;
  }
}

export function createLgtv2Client(
  options: Lgtv2ClientOptions,
): Lgtv2Client {
  return new LGTV(options) as Lgtv2Client;
}

export function mapLgtv2Error(
  cause: unknown,
  operation: Lgtv2Operation,
  hasClientKey: boolean,
): WebOsError {
  if (cause instanceof WebOsError) {
    return cause;
  }

  const error = asErrorDetails(cause);
  const status = extractSsapStatus(error);
  let code: ConstructorParameters<typeof WebOsError>[0] = 'UNKNOWN';
  if (isNetworkErrorCode(error.code)) {
    code = 'NETWORK_UNREACHABLE';
  } else if (operation === 'pair' && status === 403) {
    code = hasClientKey ? 'AUTHORIZATION_FAILED' : 'PAIRING_REJECTED';
  } else if (
    operation === 'pointer' &&
    (status === 401 || status === 403)
  ) {
    code = 'POINTER_FORBIDDEN';
  } else if (status === 404) {
    code = 'UNSUPPORTED_CAPABILITY';
  } else if (
    (status === 401 || status === 403) && capabilityForOperation(operation)
  ) {
    code = 'UNSUPPORTED_CAPABILITY';
  } else if (/timeout/i.test(error.message)) {
    code = operation === 'pair' ? 'PAIRING_TIMEOUT' : 'CONNECTION_LOST';
  } else if (
    /not connected|not open|readyState|connection closed|socket hang up/i.test(
      error.message,
    )
  ) {
    code = 'CONNECTION_LOST';
  }

  return new WebOsError(code, `lgtv2 ${operation} operation failed`, { cause });
}

function createCapabilities(wakeOnLan: boolean): MutableCapabilities {
  return tvCapabilitiesSchema.parse({
    ssap: true,
    pointer: true,
    powerOff: true,
    wakeOnLan,
    apps: true,
    inputs: true,
    textInput: true,
    notifications: true,
  });
}

function disabledMacFile(): string {
  return join(
    tmpdir(),
    `remote-webos-tv-lgtv2-disabled-${randomUUID()}.mac`,
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WebOsError('CONNECTION_LOST', 'Operation was cancelled');
  }
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new WebOsError('CONNECTION_LOST', 'Operation was cancelled'),
    );
  }

  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(new WebOsError('CONNECTION_LOST', 'Operation was cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function asErrorDetails(cause: unknown): {
  readonly code?: unknown;
  readonly errorCode?: unknown;
  readonly message: string;
} {
  if (typeof cause !== 'object' || cause === null) {
    return { message: '' };
  }
  const candidate = cause as Record<string, unknown>;
  const payload =
    typeof candidate.payload === 'object' && candidate.payload !== null
      ? (candidate.payload as Record<string, unknown>)
      : undefined;
  const errorText = candidate.errorText ?? payload?.errorText;
  return {
    ...(candidate.code === undefined ? {} : { code: candidate.code }),
    ...(candidate.errorCode === undefined && payload?.errorCode === undefined
      ? {}
      : { errorCode: candidate.errorCode ?? payload?.errorCode }),
    message:
      typeof candidate.message === 'string' && candidate.message.length > 0
        ? candidate.message
        : typeof errorText === 'string'
          ? errorText
          : '',
  };
}

function capabilityForOperation(
  operation: Lgtv2Operation,
): keyof TvCapabilities | undefined {
  switch (operation) {
    case 'pointer':
    case 'button':
      return 'pointer';
    case 'apps':
    case 'launch-app':
      return 'apps';
    case 'inputs':
    case 'switch-input':
      return 'inputs';
    case 'text':
      return 'textInput';
    case 'notification':
      return 'notifications';
    case 'power-off':
      return 'powerOff';
    case 'wake':
      return 'wakeOnLan';
    default:
      return undefined;
  }
}

function isUnsupportedCapabilityError(error: WebOsError): boolean {
  return (
    error.code === 'POINTER_FORBIDDEN' ||
    error.code === 'UNSUPPORTED_CAPABILITY'
  );
}

function withCleanupFailure(
  primary: WebOsError,
  cleanupCause: unknown,
): WebOsError {
  const aggregate = new WebOsCleanupError(
    [primary, cleanupCause],
    'Pairing operation and client cleanup failed',
    { cause: primary },
  );
  return new WebOsError(primary.code, primary.message, { cause: aggregate });
}

function isNetworkErrorCode(code: unknown): boolean {
  return [
    'ECONNFAILED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
  ].includes(String(code));
}

function extractSsapStatus(error: {
  readonly errorCode?: unknown;
  readonly message: string;
}): number | undefined {
  const explicit = Number(error.errorCode);
  if (Number.isInteger(explicit) && explicit >= 100 && explicit <= 599) {
    return explicit;
  }
  const leadingStatus = /^(\d{3})(?:\s|$)/.exec(error.message.trim());
  return leadingStatus ? Number(leadingStatus[1]) : undefined;
}
