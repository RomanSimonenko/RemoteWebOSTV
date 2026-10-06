import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import WebSocket, { WebSocketServer } from 'ws';

import {
  mockClientKey,
  mockMutationUris,
  mockResponses,
  mockUris,
} from './fixtures.js';

export type MockScenario =
  | { readonly kind: 'hello-release' }
  | { readonly kind: 'success'; readonly apps?: readonly { readonly id: string; readonly title: string }[] }
  | { readonly kind: 'reject-pairing' }
  | { readonly kind: 'deferred-pairing'; readonly gate: Promise<void> }
  | { readonly kind: 'pointer-forbidden' }
  | { readonly kind: 'close-before-response'; readonly uri: string }
  | { readonly kind: 'close-after-response'; readonly uri: string };

export interface RecordedMockRequest {
  readonly id: string;
  readonly type: 'register' | 'request' | 'subscribe' | 'unsubscribe' | 'hello';
  readonly uri?: string;
  readonly payload?: unknown;
}

interface MockWebOsTvOptions {
  readonly scenario: MockScenario;
  readonly listen?: { readonly host: string; readonly port: number; readonly advertisedHost: string };
}

interface ProtocolEnvelope {
  readonly id: string;
  readonly type: RecordedMockRequest['type'];
  readonly uri?: string;
  readonly payload?: unknown;
}

type ProtocolResponse = Readonly<Record<string, unknown>>;

export class MockWebOsTv {
  readonly #scenario: MockScenario;
  readonly #listen: MockWebOsTvOptions['listen'];
  readonly #requests: RecordedMockRequest[] = [];
  readonly #pointerFrames: string[] = [];
  readonly #requestWaiters: Array<{
    readonly count: number;
    readonly resolve: () => void;
  }> = [];
  readonly #pointerWaiters: Array<{
    readonly count: number;
    readonly resolve: () => void;
  }> = [];
  readonly #socketWaiters: Array<{
    readonly count: number;
    readonly resolve: () => void;
  }> = [];
  readonly #sockets = new Set<WebSocket>();
  #server: WebSocketServer | undefined;
  #url: string | undefined;
  #pairingPromptCount = 0;

  constructor(options: MockWebOsTvOptions) {
    this.#scenario = options.scenario;
    this.#listen = options.listen;
  }

  get url(): string {
    if (!this.#url) {
      throw new Error('Mock webOS TV has not been started');
    }
    return this.#url;
  }

  get requests(): readonly RecordedMockRequest[] {
    return structuredClone(this.#requests);
  }

  get pointerFrames(): readonly string[] {
    return [...this.#pointerFrames];
  }

  get pairingPromptCount(): number {
    return this.#pairingPromptCount;
  }

  get activeSocketCount(): number {
    return this.#sockets.size;
  }

  async start(): Promise<void> {
    if (this.#server) {
      throw new Error('Mock webOS TV is already running');
    }

    const server = new WebSocketServer({ host: this.#listen?.host ?? '127.0.0.1', port: this.#listen?.port ?? 0 });
    this.#server = server;
    server.on('connection', (socket, request) => {
      this.#sockets.add(socket);
      socket.once('close', () => {
        this.#sockets.delete(socket);
        this.#resolveSocketWaiters();
      });

      if (request.url === '/pointer') {
        socket.on('message', (data) => {
          this.#pointerFrames.push(data.toString());
          this.#resolvePointerWaiters();
        });
        return;
      }

      if (request.url !== '/') {
        socket.close(1008, 'Unknown mock endpoint');
        return;
      }

      socket.on('message', (data) => {
        void this.#handleProtocolFrame(socket, data.toString());
      });
    });

    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      await this.stop();
      throw new Error('Mock webOS TV did not receive a TCP address');
    }
    this.#url = `ws://${this.#listen?.advertisedHost ?? '127.0.0.1'}:${(address as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) {
      return;
    }
    this.#server = undefined;

    for (const socket of this.#sockets) {
      socket.terminate();
    }
    this.#sockets.clear();
    this.#resolveSocketWaiters();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  waitForPointerFrameCount(count: number): Promise<void> {
    if (this.#pointerFrames.length >= count) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#pointerWaiters.push({ count, resolve });
    });
  }

  waitForRequestCount(count: number): Promise<void> {
    if (this.#requests.length >= count) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#requestWaiters.push({ count, resolve });
    });
  }

  waitForActiveSocketCount(count: number): Promise<void> {
    if (this.#sockets.size === count) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#socketWaiters.push({ count, resolve });
    });
  }

  async #handleProtocolFrame(socket: WebSocket, raw: string): Promise<void> {
    const decoded = decodeEnvelope(raw);
    if (!decoded.ok) {
      if (decoded.id) {
        this.#sendError(
          socket,
          decoded.id,
          400,
          'invalid request',
          'Invalid request envelope',
        );
      } else {
        socket.close(1008, 'Invalid request envelope');
      }
      return;
    }

    const envelope = decoded.value;
    this.#record(envelope);

    if (envelope.type === 'hello' && this.#scenario.kind === 'hello-release') {
      // The verified TV hello response omits the request id.
      this.#send(socket, { type: 'hello', payload: {
        deviceOS: 'webOS', deviceOSVersion: '4.1.0', deviceOSReleaseVersion: '6.5.3',
      } });
      return;
    }

    if (envelope.type === 'register') {
      await this.#handleRegistration(socket, envelope);
      return;
    }

    if (envelope.type === 'unsubscribe') {
      return;
    }

    if (!envelope.uri) {
      this.#sendError(
        socket,
        envelope.id,
        400,
        'invalid request',
        'Request URI is required',
      );
      return;
    }

    if (
      this.#scenario.kind === 'close-before-response' &&
      this.#scenario.uri === envelope.uri
    ) {
      socket.close(1011, 'Mock close before response');
      return;
    }

    const response = this.#responseFor(envelope.id, envelope.uri);
    if (response) {
      if (
        this.#scenario.kind === 'close-after-response' &&
        this.#scenario.uri === envelope.uri
      ) {
        this.#send(socket, response, () => {
          socket.close(1011, 'Mock close after response');
        });
      } else {
        this.#send(socket, response);
      }
      return;
    }

    this.#sendError(
      socket,
      envelope.id,
      404,
      'no such service or method',
      'Unknown mock SSAP URI',
    );
  }

  async #handleRegistration(
    socket: WebSocket,
    envelope: ProtocolEnvelope,
  ): Promise<void> {
    if (this.#scenario.kind === 'reject-pairing') {
      this.#sendError(
        socket,
        envelope.id,
        403,
        'cancelled',
        'Pairing rejected',
      );
      return;
    }

    const suppliedKey = isRecord(envelope.payload)
      ? envelope.payload['client-key']
      : undefined;
    const shouldPrompt =
      suppliedKey !== mockClientKey ||
      this.#scenario.kind === 'deferred-pairing';

    if (shouldPrompt) {
      this.#pairingPromptCount += 1;
      this.#send(socket, {
        id: envelope.id,
        type: 'response',
        payload: { pairingType: 'PROMPT' },
      });
    }

    if (this.#scenario.kind === 'deferred-pairing') {
      await this.#scenario.gate;
    }

    this.#send(socket, {
      id: envelope.id,
      type: 'registered',
      payload: { 'client-key': mockClientKey },
    });
  }

  #responseFor(id: string, uri: string): ProtocolResponse | undefined {
    if (uri === mockUris.pointer) {
      if (this.#scenario.kind === 'pointer-forbidden') {
        return {
          id,
          type: 'error',
          error: '401 insufficient permissions',
          payload: {
            returnValue: false,
            errorCode: 401,
            errorText: 'Pointer access forbidden',
          },
        };
      }
      return {
        id,
        type: 'response',
        payload: { socketPath: `${this.url}/pointer` },
      };
    }

    if (!isMockResponseUri(uri)) {
      return isMockMutationUri(uri)
        ? { id, type: 'response', payload: { returnValue: true } }
        : undefined;
    }

    return {
      id,
      type: 'response',
      payload: this.#scenario.kind === 'success' && this.#scenario.apps && uri === mockUris.apps
        ? { returnValue: true, launchPoints: this.#scenario.apps }
        : this.#scenario.kind === 'hello-release' && uri === mockUris.softwareInfo
        ? { major_ver: '03', minor_ver: '40.85' } : mockResponses[uri],
    };
  }

  #record(envelope: ProtocolEnvelope): void {
    if (envelope.type === 'register') {
      this.#requests.push({ id: envelope.id, type: envelope.type });
      this.#resolveRequestWaiters();
      return;
    }

    this.#requests.push({
      id: envelope.id,
      type: envelope.type,
      ...(envelope.uri ? { uri: envelope.uri } : {}),
      ...(envelope.payload === undefined
        ? {}
        : { payload: redactSecrets(envelope.payload) }),
    });
    this.#resolveRequestWaiters();
  }

  #sendError(
    socket: WebSocket,
    id: string,
    code: number,
    summary: string,
    errorText: string,
  ): void {
    this.#send(socket, {
      id,
      type: 'error',
      error: `${code} ${summary}`,
      payload: {
        returnValue: false,
        errorCode: code,
        errorText,
      },
    });
  }

  #send(
    socket: WebSocket,
    response: ProtocolResponse,
    afterSend?: () => void,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(response), (error) => {
      if (!error) {
        afterSend?.();
      }
    });
  }

  #resolvePointerWaiters(): void {
    for (let index = this.#pointerWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#pointerWaiters[index];
      if (waiter && this.#pointerFrames.length >= waiter.count) {
        this.#pointerWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  #resolveRequestWaiters(): void {
    for (let index = this.#requestWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#requestWaiters[index];
      if (waiter && this.#requests.length >= waiter.count) {
        this.#requestWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  #resolveSocketWaiters(): void {
    for (let index = this.#socketWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#socketWaiters[index];
      if (waiter && this.#sockets.size === waiter.count) {
        this.#socketWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

function decodeEnvelope(
  raw: string,
):
  | { readonly ok: true; readonly value: ProtocolEnvelope }
  | { readonly ok: false; readonly id?: string } {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return { ok: false };
  }

  if (!isRecord(candidate)) {
    return { ok: false };
  }
  const id = typeof candidate.id === 'string' ? candidate.id : undefined;
  if (
    !id ||
    !['register', 'request', 'subscribe', 'unsubscribe', 'hello'].includes(
      String(candidate.type),
    )
  ) {
    return { ok: false, ...(id ? { id } : {}) };
  }

  const type = candidate.type as ProtocolEnvelope['type'];
  if (
    (type === 'request' || type === 'subscribe') &&
    typeof candidate.uri !== 'string'
  ) {
    return { ok: false, id };
  }
  if (candidate.payload !== undefined && !isRecord(candidate.payload)) {
    return { ok: false, id };
  }

  return {
    ok: true,
    value: {
      id,
      type,
      ...(typeof candidate.uri === 'string' ? { uri: candidate.uri } : {}),
      ...(candidate.payload === undefined ? {} : { payload: candidate.payload }),
    },
  };
}

function isMockResponseUri(uri: string): uri is keyof typeof mockResponses {
  return Object.prototype.hasOwnProperty.call(mockResponses, uri);
}

function isMockMutationUri(
  uri: string,
): uri is (typeof mockMutationUris)[keyof typeof mockMutationUris] {
  return Object.values(mockMutationUris).includes(
    uri as (typeof mockMutationUris)[keyof typeof mockMutationUris],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSensitiveKey(key) ? '[redacted]' : redactSecrets(nested),
    ]),
  );
}

function isSensitiveKey(key: string): boolean {
  return /^(authorization|client-?key|manifest|token)$/i.test(key);
}
