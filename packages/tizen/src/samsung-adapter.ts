import { localTvHostSchema, tvButtonSchema, type TvButton, type TvIdentity, type TvCapabilities } from '@remote-webos-tv/contracts';
import { TvButtonSendError, WebOsCleanupError, WebOsError, type PairingRequest, type PairingResult, type TvAdapter } from '@remote-webos-tv/tv-adapter';
import { createSamsungSocket, requestSamsungIdentity } from './transport.js';
import { parseSamsungEvent, parseSamsungIdentity } from './response-parsers.js';

export interface SamsungSocket {
  readonly readyState: number;
  onOpen(listener: () => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onMessage(listener: (text: string) => void): () => void;
  send(text: string, callback: (error?: Error) => void): void;
  terminate(): void;
}

export interface SamsungScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SamsungAdapterDependencies {
  readonly host: string;
  readonly handshakeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly allowPairingPrompt?: boolean;
  readonly clientName?: string;
  readonly scheduler?: SamsungScheduler;
  readonly acceptHost?: (host: string) => boolean;
  readonly requestIdentity?: (url: string, signal: AbortSignal) => Promise<unknown>;
  readonly createSocket?: (url: string, options: { readonly rejectUnauthorized: false }) => SamsungSocket;
}

const capabilities: TvCapabilities = Object.freeze({
  buttons: true, ssap: false, pointer: false, apps: false, inputs: false,
  powerOff: false, wakeOnLan: false, textInput: false, notifications: false,
});

const keys = {
  UP: 'KEY_UP', DOWN: 'KEY_DOWN', LEFT: 'KEY_LEFT', RIGHT: 'KEY_RIGHT', ENTER: 'KEY_ENTER',
  HOME: 'KEY_HOME', BACK: 'KEY_RETURN', EXIT: 'KEY_EXIT', MENU: 'KEY_MENU',
  VOLUME_UP: 'KEY_VOLUP', VOLUME_DOWN: 'KEY_VOLDOWN', MUTE: 'KEY_MUTE',
  CHANNEL_UP: 'KEY_CHUP', CHANNEL_DOWN: 'KEY_CHDOWN',
  '0': 'KEY_0', '1': 'KEY_1', '2': 'KEY_2', '3': 'KEY_3', '4': 'KEY_4',
  '5': 'KEY_5', '6': 'KEY_6', '7': 'KEY_7', '8': 'KEY_8', '9': 'KEY_9',
  RED: 'KEY_RED', GREEN: 'KEY_GREEN', YELLOW: 'KEY_YELLOW', BLUE: 'KEY_BLUE',
  PLAY: 'KEY_PLAY', PAUSE: 'KEY_PAUSE', STOP: 'KEY_STOP', REWIND: 'KEY_REWIND', FAST_FORWARD: 'KEY_FF',
} as const satisfies Record<TvButton, string>;

interface Connection {
  readonly controller: AbortController;
  readonly release: Array<() => void>;
  readonly cancelSends: Set<(cause: WebOsError) => void>;
  socket?: SamsungSocket;
  identity?: TvIdentity;
  timer?: unknown;
  ready: boolean;
  disposed: boolean;
  rejectPair?: (cause: WebOsError) => void;
  releaseAbort?: () => void;
}

const defaultScheduler: SamsungScheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createSamsungAdapter(dependencies: SamsungAdapterDependencies): TvAdapter {
  const scheduler = dependencies.scheduler ?? defaultScheduler;
  const acceptHost = dependencies.acceptHost ?? ((host) => localTvHostSchema.safeParse(host).success);
  const requestIdentity = dependencies.requestIdentity ?? requestSamsungIdentity;
  const createSocket = dependencies.createSocket ?? createSamsungSocket;
  const encodedName = Buffer.from(dependencies.clientName ?? 'RemoteWebOSTV', 'utf8').toString('base64');
  for (const timeout of [dependencies.handshakeTimeoutMs, dependencies.requestTimeoutMs]) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError('Samsung timeout must be positive and finite');
  }
  let current: Connection | undefined;
  let failedCleanup: { connection: Connection; error: WebOsError } | undefined;

  function stopTimer(connection: Connection) {
    if (connection.timer !== undefined) scheduler.clearTimeout(connection.timer);
    delete connection.timer;
  }

  function dispose(connection: Connection, cause: WebOsError): WebOsError | undefined {
    if (connection.disposed && failedCleanup?.connection !== connection) return;
    connection.disposed = true; connection.ready = false;
    if (current === connection) current = undefined;
    stopTimer(connection);
    connection.releaseAbort?.(); delete connection.releaseAbort;
    connection.controller.abort();
    const cleanupErrors: unknown[] = [];
    for (const release of connection.release.splice(0)) {
      try { release(); } catch (error) { cleanupErrors.push(error); connection.release.push(release); }
    }
    try { connection.socket?.terminate(); delete connection.socket; } catch (error) { cleanupErrors.push(error); }
    const failure = cleanupErrors.length
      ? new WebOsError(cause.code, cause.message, { cause: new WebOsCleanupError(cleanupErrors, 'Samsung connection cleanup failed', { cause }) })
      : cause;
    connection.rejectPair?.(failure); delete connection.rejectPair;
    for (const cancel of [...connection.cancelSends]) cancel(failure);
    failedCleanup = cleanupErrors.length ? { connection, error: failure } : undefined;
    return cleanupErrors.length ? failure : undefined;
  }

  function fail(connection: Connection, cause: WebOsError): void {
    // Async cleanup failure is projected to pending pair/send, retained for
    // disconnect and blocks new acquisition until the resource is released.
    dispose(connection, cause);
  }

  function requireReady(signal: AbortSignal): Connection {
    if (signal.aborted || !current?.ready || current.disposed || current.socket?.readyState !== 1) {
      throw new WebOsError('CONNECTION_LOST', 'Samsung remote connection is unavailable');
    }
    return current;
  }

  function pair(request: PairingRequest): Promise<PairingResult> {
    if (failedCleanup) return Promise.reject(failedCleanup.error);
    if (current) return Promise.reject(new WebOsError('UNKNOWN', 'Samsung connection is already active'));
    if (request.signal.aborted) return Promise.reject(new WebOsError('CONNECTION_LOST', 'Samsung pairing cancelled'));
    if (request.host !== dependencies.host || !acceptHost(request.host)) {
      return Promise.reject(new WebOsError('NETWORK_UNREACHABLE', 'Samsung host rejected by local address policy'));
    }
    if (request.credential !== undefined && (typeof request.credential !== 'string' || !request.credential.trim())) {
      return Promise.reject(new WebOsError('AUTHORIZATION_FAILED', 'Invalid Samsung credential'));
    }
    if (request.credential === undefined && dependencies.allowPairingPrompt !== true) {
      return Promise.reject(new WebOsError('AUTHORIZATION_FAILED', 'Samsung pairing requires explicit authorization'));
    }
    const connection: Connection = { controller: new AbortController(), release: [], cancelSends: new Set(), ready: false, disposed: false };
    current = connection;
    return new Promise<PairingResult>((resolve, reject) => {
      connection.rejectPair = reject;
      const abort = () => fail(connection, new WebOsError('CONNECTION_LOST', 'Samsung pairing cancelled'));
      request.signal.addEventListener('abort', abort, { once: true });
      connection.releaseAbort = () => request.signal.removeEventListener('abort', abort);
      connection.timer = scheduler.setTimeout(() => fail(connection, new WebOsError('NETWORK_UNREACHABLE', 'Samsung identity request timed out')), dependencies.requestTimeoutMs);
      Promise.resolve().then(() => {
        if (connection.disposed) return undefined;
        return requestIdentity(`http://${request.host}:8001/api/v2/`, connection.controller.signal);
      }).then((payload) => {
        if (connection.disposed || current !== connection) return;
        connection.identity = parseSamsungIdentity(payload);
        stopTimer(connection);
        const url = new URL(`wss://${request.host}:8002/api/v2/channels/samsung.remote.control`);
        url.searchParams.set('name', encodedName);
        if (request.credential !== undefined) url.searchParams.set('token', request.credential);
        const socket = createSocket(url.toString(), { rejectUnauthorized: false });
        connection.socket = socket;
        connection.timer = scheduler.setTimeout(() => fail(connection, new WebOsError('PAIRING_TIMEOUT', 'Samsung handshake timed out')), dependencies.handshakeTimeoutMs);
        connection.release.push(socket.onClose(() => fail(connection, new WebOsError('CONNECTION_LOST', 'Samsung socket closed'))));
        connection.release.push(socket.onError((cause) => fail(connection, new WebOsError('NETWORK_UNREACHABLE', 'Samsung socket failed', { cause }))));
        connection.release.push(socket.onMessage((raw) => {
          if (connection.disposed || current !== connection) return;
          try {
            const event = parseSamsungEvent(raw, encodedName, request.credential);
            if (event.event === 'unauthorized') {
              fail(connection, new WebOsError(connection.ready || request.credential !== undefined ? 'AUTHORIZATION_FAILED' : 'PAIRING_REJECTED', 'Samsung authorization rejected')); return;
            }
            if (event.event === 'timeout') { fail(connection, new WebOsError('PAIRING_TIMEOUT', 'Samsung authorization timed out')); return; }
            if (event.event === 'error') { fail(connection, new WebOsError('INVALID_TV_RESPONSE', 'Samsung reported a protocol error')); return; }
            if (event.event !== 'connect' || connection.ready) return;
            if (socket.readyState !== 1) throw new WebOsError('INVALID_TV_RESPONSE', 'Samsung connect arrived on a closed socket');
            connection.ready = true;
            stopTimer(connection); connection.releaseAbort?.(); delete connection.releaseAbort; delete connection.rejectPair;
            resolve({ credential: event.credential, identity: connection.identity!, capabilities, transport: 'wss:8002', macAddresses: [] });
          } catch (cause) {
            fail(connection, cause instanceof WebOsError ? cause : new WebOsError('INVALID_TV_RESPONSE', 'Invalid Samsung protocol event'));
          }
        }));
      }).catch((cause: unknown) => {
        if (connection.disposed) return;
        fail(connection, cause instanceof WebOsError ? cause : new WebOsError('NETWORK_UNREACHABLE', 'Samsung identity or connection request failed', { cause }));
      });
    });
  }

  async function sendButton(button: TvButton, signal: AbortSignal): Promise<void> {
    let connection: Connection;
    try { connection = requireReady(signal); }
    catch (cause) { throw new TvButtonSendError('CONNECTION_LOST', 'not_sent', 'Samsung button was not sent', { cause }); }
    const parsed = tvButtonSchema.safeParse(button);
    if (!parsed.success) throw new TvButtonSendError('UNSUPPORTED_CAPABILITY', 'not_sent', 'Unsupported Samsung button');
    const frame = JSON.stringify({ method: 'ms.remote.control', params: {
      Cmd: 'Click', DataOfCmd: keys[parsed.data], Option: 'false', TypeOfRemote: 'SendRemoteKey',
    } });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (cause?: WebOsError) => {
        if (settled) return;
        settled = true; scheduler.clearTimeout(timer);
        signal.removeEventListener('abort', abort); connection.cancelSends.delete(cancel);
        if (cause) reject(new TvButtonSendError(cause.code, 'unknown', 'Samsung button delivery is unknown', { cause }));
        else resolve();
      };
      const cancel = (cause: WebOsError) => finish(cause);
      const abort = () => finish(new WebOsError('CONNECTION_LOST', 'Samsung button cancelled after send'));
      const timer = scheduler.setTimeout(() => {
        const error = new WebOsError('CONNECTION_LOST', 'Samsung button write timed out');
        fail(connection, error);
      }, dependencies.requestTimeoutMs);
      connection.cancelSends.add(cancel); signal.addEventListener('abort', abort, { once: true });
      try {
        connection.socket!.send(frame, (cause) => {
          if (cause) { const error = new WebOsError('CONNECTION_LOST', 'Samsung button write failed', { cause }); fail(connection, error); }
          else if (signal.aborted || current !== connection || !connection.ready) abort();
          else finish();
        });
      } catch (cause) {
        const error = new WebOsError('CONNECTION_LOST', 'Samsung button write failed', { cause });
        fail(connection, error);
      }
    });
  }

  return {
    pair,
    async readSnapshot(signal) {
      const connection = requireReady(signal);
      return { connection: 'available', identity: connection.identity!, capabilities, transport: 'wss:8002' };
    },
    async prepareRemote(signal) { requireReady(signal); },
    sendButton,
    async disconnect() {
      const connection = current ?? failedCleanup?.connection;
      if (connection) {
        const failure = dispose(connection, new WebOsError('CONNECTION_LOST', 'Samsung disconnected'));
        if (failure) throw failure;
      }
    },
  };
}
