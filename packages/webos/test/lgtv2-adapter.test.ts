import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  Lgtv2Adapter,
  createLgtv2Client,
  mapLgtv2Error,
  type Lgtv2AdapterOptions,
} from '../src/lgtv2-adapter.js';
import type {
  Lgtv2Client,
  Lgtv2ClientOptions,
  Lgtv2SpecializedSocket,
} from '../src/lgtv2-types.js';
import { WebOsError } from '../src/errors.js';
import type { ClientKeyStore } from '../src/key-store.js';
import { runProbe } from '../src/probe.js';
import { MockWebOsTv } from './support/mock-webos-tv.js';
import {
  mockClientKey,
  mockMutationUris,
  mockResponses,
  mockUris,
} from './support/fixtures.js';

class MemoryKeyStore implements ClientKeyStore {
  current: string | undefined;
  readonly saved: string[] = [];

  constructor(initial?: string) {
    this.current = initial;
  }

  async load(): Promise<string | undefined> {
    return this.current;
  }

  async save(clientKey: string): Promise<void> {
    this.saved.push(clientKey);
    this.current = clientKey;
  }

  async clear(): Promise<void> {
    this.current = undefined;
  }
}

const startedMocks: MockWebOsTv[] = [];
const createdAdapters: Lgtv2Adapter[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(createdAdapters.splice(0).map((adapter) => adapter.disconnect()));
  await Promise.all(startedMocks.splice(0).map((mock) => mock.stop()));
});

async function startMock(
  scenario: ConstructorParameters<typeof MockWebOsTv>[0]['scenario'],
): Promise<MockWebOsTv> {
  const mock = new MockWebOsTv({ scenario });
  startedMocks.push(mock);
  await mock.start();
  return mock;
}

function createHarness(
  mock: MockWebOsTv,
  keyStore: ClientKeyStore,
  overrides: Partial<Lgtv2AdapterOptions> = {},
): {
  readonly adapter: Lgtv2Adapter;
  readonly configuredClients: Lgtv2ClientOptions[];
  readonly clients: Lgtv2Client[];
} {
  const port = Number(new URL(mock.url).port);
  const configuredClients: Lgtv2ClientOptions[] = [];
  const clients: Lgtv2Client[] = [];
  const adapter = new Lgtv2Adapter(
    {
      host: 'tv.invalid',
      keyStore,
      requestTimeoutMs: 2_000,
      handshakeTimeoutMs: 500,
      now: () => new Date('2026-09-03T10:00:00.000Z'),
      ...overrides,
    },
    {
      createClient(options) {
        configuredClients.push(options);
        const client = createLgtv2Client({
          ...options,
          host: '127.0.0.1',
          ports: { secure: port, insecure: port },
          verifyCert: false,
        });
        clients.push(client);
        return client;
      },
    },
  );
  createdAdapters.push(adapter);
  return { adapter, configuredClients, clients };
}

function pair(adapter: Lgtv2Adapter, signal = new AbortController().signal) {
  return adapter.pair({ host: 'tv.invalid', signal });
}

describe('Lgtv2Adapter', () => {
  test('wake routes the configured destination to the UDP owner without connecting', async () => {
    const wake = vi.fn(async () => undefined);
    const createClient = vi.fn(() => { throw new Error('Wake must not connect'); });
    const signal = new AbortController().signal;
    const adapter = new Lgtv2Adapter({
      host: 'tv.invalid', keyStore: new MemoryKeyStore(), requestTimeoutMs: 1000,
      handshakeTimeoutMs: 1000, now: () => new Date(0), wolBroadcastAddress: '192.0.2.255',
    }, { wake, createClient });
    createdAdapters.push(adapter);
    await adapter.wake(['02:00:00:00:00:01'], signal);
    expect(wake).toHaveBeenCalledWith(['02:00:00:00:00:01'], signal, '192.0.2.255');
    expect(createClient).not.toHaveBeenCalled();
  });
  test('reads hello through the real lgtv2 wire without another registration', async () => {
    const mock = await startMock({ kind: 'hello-release' });
    const { adapter } = createHarness(mock, new MemoryKeyStore(mockClientKey));
    const paired = await pair(adapter);
    expect(paired.identity.platformVersion).toBeUndefined();
    expect(await adapter.readPlatformVersion(new AbortController().signal)).toEqual({ version: '6.5.3' });
    expect((await adapter.readSnapshot(new AbortController().signal)).identity).toEqual({
      model: '43UP76906LE', firmwareVersion: '03.40.85', platformVersion: '6.5.3',
    });
    expect(mock.requests.filter((request) => request.type === 'register')).toHaveLength(1);
    expect(mock.requests.find((request) => request.type === 'hello')).toMatchObject({ payload: {} });
  });

  test('preserves SDK version without sending optional hello', async () => {
    const send = vi.fn(() => { throw new Error('hello must not be sent'); });
    const { adapter } = createUnitAdapter({ send });
    await pair(adapter);
    expect(await adapter.readPlatformVersion(new AbortController().signal)).toEqual({ version: '6.5.3' });
    expect(send).not.toHaveBeenCalled();
  });

  test('disconnect cancels pending optional hello and clears its deadline', async () => {
    vi.useFakeTimers();
    const harness = createHelloAdapter(() => undefined);
    await pair(harness.adapter);
    const pending = harness.adapter.readPlatformVersion(new AbortController().signal);
    await harness.sent;
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    await harness.adapter.disconnect();
    await rejected;
    expect(harness.client().listenerCount('message')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  test('acquires correlated hello release when the software response omits SDK', async () => {
    const harness = createHelloAdapter((client) => {
      client.emit('message', JSON.stringify({ id: 'other', type: 'hello', payload: { deviceOS: 'webOS', deviceOSReleaseVersion: '99' } }));
      client.emit('message', JSON.stringify({ type: 'hello', payload: { deviceOS: 'webOS', deviceOSVersion: '4.1.0', deviceOSReleaseVersion: '6.5.3' } }));
    });
    await pair(harness.adapter);
    const result = await harness.adapter.readPlatformVersion(new AbortController().signal);
    expect(result).toEqual({ version: '6.5.3' });
    expect(harness.client().listenerCount('message')).toBe(0);
  });

  test.each([
    [{ type: 'hello', payload: { deviceOS: 'webOS', deviceOSReleaseVersion: '' } }, 'invalid_response'],
    [{ type: 'hello', payload: { deviceOS: 'webOS', deviceOSReleaseVersion: 6 } }, 'invalid_response'],
    [{ type: 'hello', payload: { deviceOS: 'other', deviceOSReleaseVersion: '6.5.3' } }, 'invalid_response'],
    [{ type: 'response', payload: { deviceOS: 'webOS', deviceOSReleaseVersion: '6.5.3' } }, 'invalid_response'],
    [{ type: 'hello', payload: { deviceOS: 'webOS' } }, 'version_unavailable'],
    [{ type: 'error', error: 'synthetic unsupported hello' }, 'request_rejected'],
  ])('keeps pairing usable with observable optional metadata failure', async (response, code) => {
    const harness = createHelloAdapter((client) => client.emit('message', JSON.stringify({ id: 'hello-id', ...response })));
    await pair(harness.adapter);
    const result = await harness.adapter.readPlatformVersion(new AbortController().signal);
    expect(result).toEqual({ diagnostic: { operation: 'hello', code } });
    expect((await harness.adapter.readSnapshot(new AbortController().signal)).connection).toBe('available');
    expect(harness.client().listenerCount('message')).toBe(0);
  });

  test('optional hello timeout preserves pairing and clears listeners and timers', async () => {
    vi.useFakeTimers();
    const harness = createHelloAdapter(() => undefined);
    await pair(harness.adapter);
    const pending = harness.adapter.readPlatformVersion(new AbortController().signal);
    await harness.sent;
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;
    expect(result).toEqual({ diagnostic: { operation: 'hello', code: 'timeout' } });
    expect((await harness.adapter.readSnapshot(new AbortController().signal)).connection).toBe('available');
    expect(harness.client().listenerCount('message')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('cancelling optional hello cleans up without disabling the paired remote', async () => {
    vi.useFakeTimers();
    const harness = createHelloAdapter(() => undefined);
    const controller = new AbortController();
    await pair(harness.adapter);
    const pending = harness.adapter.readPlatformVersion(controller.signal);
    await harness.sent;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(harness.client().listenerCount('message')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect((await harness.adapter.readSnapshot(new AbortController().signal)).connection).toBe('available');
  });

  test('failed hello send reports metadata failure while preserving paired control', async () => {
    const { adapter } = createUnitAdapter({
      request: async (uri) => uri === mockUris.softwareInfo ? {} : responseForPairing(uri),
      send: () => { throw new Error('synthetic send failure'); },
    });
    await pair(adapter);
    expect(await adapter.readPlatformVersion(new AbortController().signal)).toEqual({ diagnostic: { operation: 'hello', code: 'send_failed' } });
    expect((await adapter.readSnapshot(new AbortController().signal)).connection).toBe('available');
  });

  test('cancelled hello receiver cannot mutate identity from the EventEmitter listener snapshot', async () => {
    const controller = new AbortController();
    const harness = createHelloAdapter((client) => client.emit('message', JSON.stringify({
      id: 'hello-id', type: 'hello', payload: { deviceOS: 'webOS', deviceOSReleaseVersion: '6.5.3' },
    })));
    await pair(harness.adapter);
    // Earlier listener cancels during this same emission. EventEmitter still
    // invokes listeners from its snapshot after removeListener cleanup.
    harness.client().on('message', () => controller.abort());
    await expect(harness.adapter.readPlatformVersion(controller.signal)).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect((await harness.adapter.readSnapshot(new AbortController().signal)).identity?.platformVersion).toBeUndefined();
  });

  test('rejects a second hello acquisition on the same client so idless replies cannot cross attempts', async () => {
    const harness = createHelloAdapter(() => undefined);
    await pair(harness.adapter);
    const controller = new AbortController();
    const pending = harness.adapter.readPlatformVersion(controller.signal);
    await harness.sent;
    const second = harness.adapter.readPlatformVersion(new AbortController().signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    await expect(second).rejects.toMatchObject({ code: 'UNKNOWN' });
    await expect(harness.adapter.readPlatformVersion(new AbortController().signal)).rejects.toMatchObject({ code: 'UNKNOWN' });
  });
  test('power delivery is not_sent before SSAP and unknown after request failure', async () => {
    const cause = new WebOsError('CONNECTION_LOST', 'synthetic ambiguous request');
    const request = vi.fn(async (uri: string) => { if (uri === mockMutationUris.powerOff) throw cause; return responseForPairing(uri); });
    const { adapter } = createUnitAdapter({ request });
    await expect(adapter.powerOff(new AbortController().signal)).rejects.toMatchObject({ delivery: 'not_sent', code: 'CONNECTION_LOST' });
    await pair(adapter);
    request.mockClear();
    await expect(adapter.powerOff(new AbortController().signal)).rejects.toMatchObject({ delivery: 'unknown', code: 'CONNECTION_LOST', cause });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('power request cancellation retains the raw request owner until it settles', async () => {
    let reject!: (cause: unknown) => void;
    const { adapter } = createUnitAdapter({ request: async (uri) => uri === mockMutationUris.powerOff
      ? new Promise((_yes, no) => { reject = no; }) : responseForPairing(uri) }); await pair(adapter);
    const controller = new AbortController(); const pending = adapter.powerOff(controller.signal);
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    controller.abort(); for (let turn = 0; turn < 10; turn++) await Promise.resolve(); expect(settled).toBe(false);
    reject(new WebOsError('CONNECTION_LOST', 'synthetic cancelled send'));
    await expect(pending).rejects.toMatchObject({ delivery: 'unknown' });
  });
  test('classifies preparation failure as not_sent and send failure as unknown', async () => {
    const cause = new Error('synthetic failure');
    const preparing = createUnitAdapter({ getSocket: async () => { throw cause; } }); await pair(preparing.adapter);
    await expect(preparing.adapter.sendButton('HOME', new AbortController().signal)).rejects.toMatchObject({ code: 'UNKNOWN', delivery: 'not_sent', cause: expect.any(WebOsError) });
    const sending = createUnitAdapter({ getSocket: async () => ({ send: () => { throw cause; }, close() {} }) }); await pair(sending.adapter);
    await expect(sending.adapter.sendButton('HOME', new AbortController().signal)).rejects.toMatchObject({ code: 'UNKNOWN', delivery: 'unknown' });
  });

  test('late pointer acquisition after cancellation never sends', async () => {
    let release!: (socket: Lgtv2SpecializedSocket) => void;
    const pointer = new Promise<Lgtv2SpecializedSocket>((resolve) => { release = resolve; });
    const send = vi.fn(); const { adapter } = createUnitAdapter({ getSocket: () => pointer }); await pair(adapter);
    const controller = new AbortController(); const pending = adapter.sendButton('HOME', controller.signal);
    controller.abort(); release({ send, close() {} });
    await expect(pending).rejects.toMatchObject({ delivery: 'not_sent' }); expect(send).not.toHaveBeenCalled();
  });

  test('abort at the send boundary reports unknown rather than not_sent', async () => {
    const controller = new AbortController(); const send = vi.fn(() => controller.abort());
    const { adapter } = createUnitAdapter({ getSocket: async () => ({ send, close() {} }) }); await pair(adapter);
    await expect(adapter.sendButton('HOME', controller.signal)).rejects.toMatchObject({ delivery: 'unknown' }); expect(send).toHaveBeenCalledTimes(1);
  });

  test('closes a late pointer from the disconnected client without sending', async () => {
    let release!: (socket: Lgtv2SpecializedSocket) => void;
    const pointer = new Promise<Lgtv2SpecializedSocket>((resolve) => { release = resolve; });
    const send = vi.fn(); const close = vi.fn(); const { adapter } = createUnitAdapter({ getSocket: () => pointer }); await pair(adapter);
    const pending = adapter.sendButton('HOME', new AbortController().signal);
    await adapter.disconnect(); release({ send, close });
    await expect(pending).rejects.toMatchObject({ delivery: 'not_sent', code: 'CONNECTION_LOST' });
    expect(send).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
  });

  test('cancelled same-client preparation leaves the reusable socket owned by that client', async () => {
    let release!: (socket: Lgtv2SpecializedSocket) => void;
    const pointer = new Promise<Lgtv2SpecializedSocket>((resolve) => { release = resolve; });
    const send = vi.fn(); const close = vi.fn(); const { adapter } = createUnitAdapter({ getSocket: () => pointer }); await pair(adapter);
    const controller = new AbortController(); const pending = adapter.sendButton('HOME', controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ delivery: 'not_sent' }); release({ send, close });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(close).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    await adapter.sendButton('UP', new AbortController().signal);
    expect(send).toHaveBeenCalledExactlyOnceWith('button', { name: 'UP' });
    await adapter.disconnect(); expect(close).toHaveBeenCalledTimes(1);
  });

  test('coalesces overlapping acquisitions after abort so late cache overwrite cannot orphan a socket', async () => {
    // Match lgtv2: only completed sockets are cached, and every open overwrites
    // that cache. Disconnect closes the cached socket, not all historic sockets.
    let cached: Lgtv2SpecializedSocket | undefined;
    const frames: string[] = [];
    const sockets: Array<{ closed: boolean }> = [];
    const acquisitions: Array<{ open(): void }> = [];
    const getSocket = () => {
      if (cached) return Promise.resolve(cached);
      return new Promise<Lgtv2SpecializedSocket>((resolve) => {
        acquisitions.push({ open() {
          const state = { closed: false }; sockets.push(state);
          const socket: Lgtv2SpecializedSocket = {
            send(_type, payload) { frames.push(String(payload?.name)); },
            close() { state.closed = true; },
          };
          cached = socket; resolve(socket);
        } });
      });
    };
    const { adapter } = createUnitAdapter({ getSocket, disconnect: async () => { cached?.close(); cached = undefined; } }); await pair(adapter);
    const controller = new AbortController(); const first = adapter.sendButton('HOME', controller.signal); controller.abort();
    await expect(first).rejects.toMatchObject({ delivery: 'not_sent' });
    const second = adapter.sendButton('UP', new AbortController().signal);
    const firstAcquisition = acquisitions[0]!; const newestAcquisition = acquisitions.at(-1)!;
    newestAcquisition.open(); await second;
    if (firstAcquisition !== newestAcquisition) firstAcquisition.open();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    await adapter.sendButton('RIGHT', new AbortController().signal); await adapter.disconnect();
    expect(frames).toEqual(['UP', 'RIGHT']);
    expect.soft(acquisitions).toHaveLength(1); expect(sockets.every((socket) => socket.closed)).toBe(true);
  });

  test('failed shared acquisition releases ownership for the next explicit command', async () => {
    let reject!: (cause: unknown) => void;
    const pendingPointer = new Promise<Lgtv2SpecializedSocket>((_resolve, no) => { reject = no; });
    const send = vi.fn(); const getSocket = vi.fn<() => Promise<Lgtv2SpecializedSocket>>().mockReturnValueOnce(pendingPointer).mockResolvedValue({ send, close() {} });
    const { adapter } = createUnitAdapter({ getSocket }); await pair(adapter);
    const controller = new AbortController(); const cancelled = adapter.sendButton('HOME', controller.signal); controller.abort();
    await expect(cancelled).rejects.toMatchObject({ delivery: 'not_sent' });
    const waiting = adapter.sendButton('UP', new AbortController().signal);
    const assertion = expect(waiting).rejects.toMatchObject({ code: 'CONNECTION_LOST', delivery: 'not_sent' });
    reject(new WebOsError('CONNECTION_LOST', 'synthetic acquisition failure')); await assertion;
    await adapter.sendButton('RIGHT', new AbortController().signal);
    expect(getSocket).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledExactlyOnceWith('button', { name: 'RIGHT' });
  });

  test('old acquisition settlement cannot release a pending replacement acquisition', async () => {
    let oldRelease!: (socket: Lgtv2SpecializedSocket) => void; let newRelease!: (socket: Lgtv2SpecializedSocket) => void;
    const oldPointer = new Promise<Lgtv2SpecializedSocket>((resolve) => { oldRelease = resolve; });
    const newPointer = new Promise<Lgtv2SpecializedSocket>((resolve) => { newRelease = resolve; });
    const oldClose = vi.fn(); const newClose = vi.fn();
    const getSocket = vi.fn<() => Promise<Lgtv2SpecializedSocket>>().mockReturnValueOnce(oldPointer).mockReturnValue(newPointer);
    const { adapter } = createUnitAdapter({ getSocket }); await pair(adapter);
    const controller = new AbortController(); const cancelled = adapter.openPointerSocket(controller.signal); controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'CONNECTION_LOST' }); await adapter.disconnect(); await pair(adapter);
    const first = adapter.openPointerSocket(new AbortController().signal);
    oldRelease({ send: vi.fn(), close: oldClose }); for (let index = 0; index < 10; index++) await Promise.resolve();
    const second = adapter.openPointerSocket(new AbortController().signal);
    newRelease({ send: vi.fn(), close: newClose }); await Promise.all([first, second]);
    expect(getSocket).toHaveBeenCalledTimes(2); expect(oldClose).toHaveBeenCalledTimes(1); expect(newClose).not.toHaveBeenCalled();
  });

  test.each(['sent', 'preparation-failure', 'send-failure'] as const)('real CLI command path preserves safe output and exit for %s', async (result) => {
    const send = vi.fn(() => { if (result === 'send-failure') throw new Error('private send cause'); });
    const { adapter } = createUnitAdapter({ getSocket: async () => {
      if (result === 'preparation-failure') throw new WebOsError('CONNECTION_LOST', 'private preparation cause');
      return { send, close() {} };
    } });
    const cli = await runAdapterCli(adapter);
    expect(cli.exitCode).toBe(result === 'sent' ? 0 : 1);
    expect(cli.output).toContain(result === 'sent' ? 'button: pass' : result === 'preparation-failure' ? 'CONNECTION_LOST' : 'UNKNOWN');
    expect(cli.output).not.toMatch(/private|tv\.invalid|synthetic-mock-client-key/);
    expect(send).toHaveBeenCalledTimes(result === 'preparation-failure' ? 0 : 1);
  });

  test('real CLI cancels pending acquisition eagerly and a late socket never sends', async () => {
    let entered!: () => void; const enteredPointer = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (socket: Lgtv2SpecializedSocket) => void;
    const pointer = new Promise<Lgtv2SpecializedSocket>((resolve) => { release = resolve; });
    const { adapter } = createUnitAdapter({ getSocket: () => { entered(); return pointer; } });
    const listeners = new Map<string, () => void>(); const pending = runAdapterCli(adapter, listeners);
    await enteredPointer; listeners.get('SIGINT')!(); const cli = await pending;
    expect(cli.exitCode).toBe(1); expect(cli.output).toContain('CONNECTION_LOST'); expect(listeners.size).toBe(0);
    const send = vi.fn(); const close = vi.fn(); release({ send, close });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(send).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
  });

  test('late old-client pointer cleanup cannot close the replacement pointer', async () => {
    let release!: (socket: Lgtv2SpecializedSocket) => void;
    const oldPointer = new Promise<Lgtv2SpecializedSocket>((resolve) => { release = resolve; });
    const oldSend = vi.fn(); const oldClose = vi.fn(); const newSend = vi.fn(); const newClose = vi.fn();
    const getSocket = vi.fn<() => Promise<Lgtv2SpecializedSocket>>().mockReturnValueOnce(oldPointer).mockResolvedValue({ send: newSend, close: newClose });
    const { adapter } = createUnitAdapter({ getSocket }); await pair(adapter);
    const controller = new AbortController(); const pending = adapter.sendButton('HOME', controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ delivery: 'not_sent' });
    await adapter.disconnect(); await pair(adapter); await adapter.sendButton('UP', new AbortController().signal);
    release({ send: oldSend, close: oldClose }); for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(oldSend).not.toHaveBeenCalled(); expect(oldClose).toHaveBeenCalledTimes(1);
    expect(newSend).toHaveBeenCalledExactlyOnceWith('button', { name: 'UP' }); expect(newClose).not.toHaveBeenCalled();
  });

  test('late stale-pointer cleanup failure remains causal and observable on disconnect', async () => {
    let release!: (socket: Lgtv2SpecializedSocket) => void;
    const pointer = new Promise<Lgtv2SpecializedSocket>((resolve) => { release = resolve; });
    const cause = new Error('synthetic cleanup'); const { adapter } = createUnitAdapter({ getSocket: () => pointer }); await pair(adapter);
    const controller = new AbortController(); const pending = adapter.sendButton('HOME', controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ delivery: 'not_sent' }); await adapter.disconnect();
    release({ send: vi.fn(), close() { throw cause; } }); for (let index = 0; index < 10; index++) await Promise.resolve();
    await expect(adapter.disconnect()).rejects.toMatchObject({ code: 'CONNECTION_LOST', cause });
    createdAdapters.splice(createdAdapters.indexOf(adapter), 1);
  });

  test('refuses a fresh PROMPT for a saved-key reconnect and never saves a replacement', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = await startMock({ kind: 'deferred-pairing', gate });
    const keyStore = new MemoryKeyStore(mockClientKey);
    const { adapter } = createHarness(mock, keyStore, { allowPairingPrompt: false });
    const pending = pair(adapter);
    await expect(pending).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED' });
    await mock.waitForActiveSocketCount(0);
    release();
    expect(keyStore.current).toBe(mockClientKey);
    expect(keyStore.saved).toEqual([]);
    expect(mock.requests).toHaveLength(1);
  });

  test('uses secure-first fallback and saves a key only after registration', async () => {
    let releasePairing!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePairing = resolve;
    });
    const mock = await startMock({ kind: 'deferred-pairing', gate });
    const keyStore = new MemoryKeyStore();
    const { adapter, configuredClients } = createHarness(mock, keyStore);

    const pendingPairing = pair(adapter);
    await mock.waitForRequestCount(1);
    expect(mock.pairingPromptCount).toBe(1);
    expect(keyStore.saved).toEqual([]);

    releasePairing();
    await expect(pendingPairing).resolves.toMatchObject({
      clientKey: mockClientKey,
      identity: {
        model: '43UP76906LE',
        platformVersion: '6.5.3',
        firmwareVersion: '03.40.85',
      },
      transport: 'ws:3000',
      macAddresses: ['02:00:00:00:00:01', '02:00:00:00:00:02'],
    });
    expect(keyStore.saved).toEqual([mockClientKey]);
    expect(configuredClients[0]).toMatchObject({
      host: 'tv.invalid',
      clientKey: '',
      timeout: 2_000,
      handshakeTimeout: 500,
      reconnect: 0,
      verifyCert: 'lg',
      learnMac: false,
    });
    expect(configuredClients[0]).not.toHaveProperty('url');
    expect(configuredClients[0]).not.toHaveProperty('secure');
    expect(configuredClients[0]).not.toHaveProperty('ports');
  });

  test('reuses the saved key without another prompt or write', async () => {
    const mock = await startMock({ kind: 'success' });
    const keyStore = new MemoryKeyStore();
    const { adapter, configuredClients } = createHarness(mock, keyStore);

    await pair(adapter);
    await adapter.disconnect();
    await pair(adapter);

    expect(mock.pairingPromptCount).toBe(1);
    expect(keyStore.saved).toEqual([mockClientKey]);
    expect(configuredClients).toHaveLength(2);
    expect(configuredClients[1]?.clientKey).toBe(mockClientKey);
  });

  test('reads snapshot, apps and inputs through the owned contracts', async () => {
    const mock = await startMock({ kind: 'success' });
    const { adapter } = createHarness(mock, new MemoryKeyStore());
    const pairing = await pair(adapter);
    const signal = new AbortController().signal;

    await expect(adapter.readSnapshot(signal)).resolves.toEqual({
      connection: 'available',
      identity: pairing.identity,
      capabilities: pairing.capabilities,
      transport: 'ws:3000',
      volume: 17,
      muted: false,
    });
    await expect(adapter.listApps(signal)).resolves.toEqual([
      { id: 'com.webos.app.livetv', name: 'TV' },
      { id: 'youtube.leanback.v4', name: 'YouTube' },
    ]);
    await expect(adapter.listInputs(signal)).resolves.toEqual([
      { id: 'HDMI_1', label: 'HDMI 1', connected: true },
      { id: 'HDMI_2', label: 'HDMI 2', connected: false },
    ]);
  });

  test('sends typed mutations through their exact SSAP and pointer boundaries', async () => {
    const mock = await startMock({ kind: 'success' });
    const { adapter } = createHarness(mock, new MemoryKeyStore());
    const signal = new AbortController().signal;
    await pair(adapter, signal);

    await adapter.sendButton('FAST_FORWARD', signal);
    await mock.waitForPointerFrameCount(1);
    await adapter.setVolume(23, signal);
    await adapter.launchApp('youtube.leanback.v4', signal);
    await adapter.switchInput('HDMI_1', signal);
    await adapter.insertText('synthetic text', signal);
    await adapter.createNotification('synthetic notification', signal);
    await adapter.powerOff(signal);

    expect(mock.pointerFrames).toEqual([
      'type:button\nname:FASTFORWARD\n\n',
    ]);
    expect(
      mock.requests
        .filter((request) =>
          Object.values(mockMutationUris).includes(
            request.uri as (typeof mockMutationUris)[keyof typeof mockMutationUris],
          ),
        )
        .map(({ uri, payload }) => ({ uri, payload })),
    ).toEqual([
      { uri: mockMutationUris.setVolume, payload: { volume: 23 } },
      {
        uri: mockMutationUris.launchApp,
        payload: { id: 'youtube.leanback.v4' },
      },
      {
        uri: mockMutationUris.switchInput,
        payload: { inputId: 'HDMI_1' },
      },
      {
        uri: mockMutationUris.insertText,
        payload: { text: 'synthetic text', replace: 0 },
      },
      {
        uri: mockMutationUris.notification,
        payload: { message: 'synthetic notification' },
      },
      { uri: mockMutationUris.powerOff, payload: undefined },
    ]);
  });

  test('launch cancellation retains request ownership until the raw response settles', async () => {
    let resolve!: (value: unknown) => void;
    const deferred = new Promise<unknown>((done) => { resolve = done; });
    const { adapter } = createUnitAdapter({ request: async (uri) => uri === mockMutationUris.launchApp ? deferred : responseForPairing(uri) });
    await pair(adapter);
    const controller = new AbortController(); let settled = false;
    const pending = adapter.launchApp('synthetic.wink', controller.signal).then(() => { settled = true; }, () => { settled = true; });
    controller.abort();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    const earlySettlement = settled;
    resolve({ returnValue: true }); await pending;
    expect(earlySettlement).toBe(false);
  });

  test('does not send a mutating request when the signal is already aborted', async () => {
    const mock = await startMock({ kind: 'success' });
    const { adapter, clients } = createHarness(mock, new MemoryKeyStore());
    await pair(adapter);
    const request = vi.spyOn(clients[0]!, 'request');
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.powerOff(controller.signal)).rejects.toMatchObject({
      code: 'CONNECTION_LOST',
    });
    expect(request).not.toHaveBeenCalled();
  });

  test('waits for the wake resource owner to close after cancellation', async () => {
    let abortObserved = false;
    let emitClose!: () => void;
    const wake = vi.fn(
      (
        _macAddresses: readonly string[],
        operationSignal?: AbortSignal,
      ): Promise<void> =>
        new Promise((_resolve, reject) => {
          if (!operationSignal) {
            reject(new Error('Wake operation did not receive an AbortSignal'));
            return;
          }
          operationSignal.addEventListener(
            'abort',
            () => {
              abortObserved = true;
            },
            { once: true },
          );
          emitClose = () => {
            reject(
              new WebOsError(
                'CONNECTION_LOST',
                'Wake-on-LAN operation was cancelled',
              ),
            );
          };
        }),
    );
    const adapter = new Lgtv2Adapter(
      {
        host: '192.0.2.10',
        keyStore: new MemoryKeyStore(),
        requestTimeoutMs: 2_000,
        handshakeTimeoutMs: 500,
        now: () => new Date('2026-09-03T10:00:00.000Z'),
      },
      { wake },
    );
    createdAdapters.push(adapter);
    const controller = new AbortController();

    const pending = adapter.wake(['02:00:00:00:00:01'], controller.signal);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();

    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve();
    }
    expect(abortObserved).toBe(true);
    expect(settled).toBe(false);

    emitClose();
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });

  test('does not create a wake resource when the signal is already aborted', async () => {
    const wake = vi.fn(async () => undefined);
    const adapter = new Lgtv2Adapter(
      {
        host: '192.0.2.10',
        keyStore: new MemoryKeyStore(),
        requestTimeoutMs: 2_000,
        handshakeTimeoutMs: 500,
        now: () => new Date('2026-09-03T10:00:00.000Z'),
      },
      { wake },
    );
    createdAdapters.push(adapter);
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.wake(['02:00:00:00:00:01'], controller.signal),
    ).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(wake).not.toHaveBeenCalled();
  });

  test.each([
    [undefined, 'PAIRING_REJECTED'],
    ['existing-synthetic-key', 'AUTHORIZATION_FAILED'],
  ] as const)(
    'maps a 403 pairing failure with stored key %s to %s and cleans up',
    async (storedKey, expectedCode) => {
      const mock = await startMock({ kind: 'reject-pairing' });
      const { adapter } = createHarness(mock, new MemoryKeyStore(storedKey));

      await expect(pair(adapter)).rejects.toMatchObject({ code: expectedCode });
      await mock.waitForActiveSocketCount(0);
      expect(mock.activeSocketCount).toBe(0);
    },
  );

  test('maps pointer 401 separately and exposes no connection details', async () => {
    const mock = await startMock({ kind: 'pointer-forbidden' });
    const { adapter } = createHarness(mock, new MemoryKeyStore());
    await pair(adapter);

    let captured: unknown;
    try {
      await adapter.openPointerSocket(new AbortController().signal);
    } catch (error) {
      captured = error;
    }

    expect(captured).toMatchObject({ code: 'POINTER_FORBIDDEN' });
    const safe = JSON.stringify(
      (captured as { toSafeDiagnostic(): unknown }).toSafeDiagnostic(),
    );
    for (const sensitive of [
      'tv.invalid',
      mockClientKey,
      '02:00:00:00:00:01',
      'remote-webos-tv-lgtv2-disabled',
      'socketPath',
    ]) {
      expect(safe).not.toContain(sensitive);
    }
  });

  test('maps a dropped state request to connection loss', async () => {
    const mock = await startMock({
      kind: 'close-before-response',
      uri: 'ssap://audio/getVolume',
    });
    const { adapter } = createHarness(mock, new MemoryKeyStore());
    await pair(adapter);

    await expect(
      adapter.readSnapshot(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });

  test('times out pairing deterministically and disconnects the client', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const disconnect = vi.fn(async () => undefined);
    const hangingClient = createHangingClient(disconnect);
    const adapter = new Lgtv2Adapter(
      {
        host: 'tv.invalid',
        keyStore: new MemoryKeyStore(),
        requestTimeoutMs: 5_000,
        handshakeTimeoutMs: 500,
        now: () => new Date('2026-09-03T10:00:00.000Z'),
      },
      { createClient: () => hangingClient },
    );
    createdAdapters.push(adapter);

    const pending = pair(adapter);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'PAIRING_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await assertion;
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test('cancels pairing and closes the socket without waiting for the TV', async () => {
    const gate = new Promise<void>(() => undefined);
    const mock = await startMock({ kind: 'deferred-pairing', gate });
    const { adapter } = createHarness(mock, new MemoryKeyStore());
    const controller = new AbortController();
    const pending = pair(adapter, controller.signal);
    await mock.waitForRequestCount(1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    await mock.waitForActiveSocketCount(0);
    expect(mock.activeSocketCount).toBe(0);
  });

  test('maps library errors at their owning operation boundary', () => {
    expect(
      mapLgtv2Error(
        Object.assign(new Error('synthetic'), { code: 'ECONNFAILED' }),
        'pair',
        false,
      ),
    ).toMatchObject({ code: 'NETWORK_UNREACHABLE' });
    expect(
      mapLgtv2Error(
        Object.assign(new Error('synthetic'), {
          code: 'ESSAP',
          errorCode: 404,
        }),
        'apps',
        false,
      ),
    ).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(
      mapLgtv2Error(new Error('timeout'), 'pair', false),
    ).toMatchObject({ code: 'PAIRING_TIMEOUT' });
  });

  test.each([
    ['pointer', 403, 'POINTER_FORBIDDEN'],
    ['apps', 404, 'UNSUPPORTED_CAPABILITY'],
  ] as const)(
    'maps nested lgtv2 %s payload status %s without relying on message text',
    (operation, status, expectedCode) => {
      const error = Object.assign(new Error('request failed without status'), {
        code: 'ESSAP',
        payload: {
          returnValue: false,
          errorCode: status,
          errorText: 'synthetic endpoint failure',
        },
      });

      expect(mapLgtv2Error(error, operation, true)).toMatchObject({
        code: expectedCode,
      });
    },
  );

  test('obtains the current pointer wrapper for a command after the prior socket closes', async () => {
    const firstSend = vi.fn();
    const secondSend = vi.fn();
    const firstSocket: Lgtv2SpecializedSocket = {
      send: firstSend,
      close: vi.fn(),
    };
    const secondSocket: Lgtv2SpecializedSocket = {
      send: secondSend,
      close: vi.fn(),
    };
    const getSocket = vi
      .fn<() => Promise<Lgtv2SpecializedSocket>>()
      .mockResolvedValueOnce(firstSocket)
      .mockResolvedValueOnce(secondSocket);
    const { adapter } = createUnitAdapter({ getSocket });
    await pair(adapter);

    await adapter.openPointerSocket(new AbortController().signal);
    firstSocket.close();
    await adapter.sendButton('HOME', new AbortController().signal);

    expect(getSocket).toHaveBeenCalledTimes(2);
    expect(firstSend).not.toHaveBeenCalled();
    expect(secondSend).toHaveBeenCalledWith('button', { name: 'HOME' });
  });

  test('returns connection loss when lgtv2 still caches a closed pointer wrapper', async () => {
    const send = vi.fn();
    const transport = { readyState: 1 };
    const socket = {
      ws: transport,
      send,
      close: () => {
        transport.readyState = 3;
      },
    } as Lgtv2SpecializedSocket & { readonly ws: { readonly readyState: number } };
    const getSocket = vi.fn(async () => socket);
    const { adapter } = createUnitAdapter({ getSocket });
    await pair(adapter);

    await adapter.openPointerSocket(new AbortController().signal);
    socket.close();

    await expect(
      adapter.sendButton('HOME', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(getSocket).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  test.each([
    ['pointer', 'pointer'],
    ['apps', 'apps'],
  ] as const)(
    'downgrades the shared %s capability after an observed forbidden endpoint',
    async (operation, capability) => {
      const endpointError = Object.assign(new Error('permission denied'), {
        code: 'ESSAP',
        payload: {
          returnValue: false,
          errorCode: 403,
          errorText: 'synthetic endpoint failure',
        },
      });
      const { adapter } = createUnitAdapter({
        ...(operation === 'pointer'
          ? { getSocket: vi.fn(async () => Promise.reject(endpointError)) }
          : {
              request: vi.fn(async (uri: string) => {
                if (uri === mockUris.apps) {
                  throw endpointError;
                }
                return responseForPairing(uri);
              }),
            }),
      });
      const pairing = await pair(adapter);

      if (operation === 'pointer') {
        await expect(
          adapter.openPointerSocket(new AbortController().signal),
        ).rejects.toMatchObject({ code: 'POINTER_FORBIDDEN' });
      } else {
        await expect(
          adapter.listApps(new AbortController().signal),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
      }

      expect(pairing.capabilities[capability]).toBe(false);
      await expect(
        adapter.readSnapshot(new AbortController().signal),
      ).resolves.toMatchObject({
        capabilities: { [capability]: false },
      });
    },
  );

  test('preserves the primary pairing timeout when disconnect cleanup also fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cleanupFailure = new Error('synthetic disconnect failure');
    const hangingClient = createHangingClient(async () =>
      Promise.reject(cleanupFailure),
    );
    const adapter = new Lgtv2Adapter(
      {
        host: 'tv.invalid',
        keyStore: new MemoryKeyStore(),
        requestTimeoutMs: 5_000,
        handshakeTimeoutMs: 500,
        now: () => new Date('2026-09-03T10:00:00.000Z'),
      },
      { createClient: () => hangingClient },
    );
    createdAdapters.push(adapter);

    const pending = pair(adapter).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    const captured = await pending;

    expect(captured).toMatchObject({ code: 'PAIRING_TIMEOUT' });
    expect((captured as Error).cause).toMatchObject({ name: 'WebOsCleanupError' });
    expect((captured as Error).cause).toBeInstanceOf(AggregateError);
    expect(((captured as Error).cause as AggregateError).errors).toEqual([
      expect.objectContaining({ code: 'PAIRING_TIMEOUT' }),
      cleanupFailure,
    ]);
  });

  test('disconnect is idempotent', async () => {
    const mock = await startMock({ kind: 'success' });
    const { adapter } = createHarness(mock, new MemoryKeyStore());
    await pair(adapter);

    await adapter.disconnect();
    await adapter.disconnect();

    await mock.waitForActiveSocketCount(0);
    expect(mock.activeSocketCount).toBe(0);
  });
});

function createHangingClient(
  disconnect: () => Promise<void>,
): Lgtv2Client {
  const client = {
    connected: false,
    urls: ['wss://tv.invalid:3001', 'ws://tv.invalid:3000'],
    on: () => client,
    removeListener: () => client,
    send: () => undefined,
    request: async () => new Promise<never>(() => undefined),
    getSocket: async () => new Promise<never>(() => undefined),
    wake: async () => undefined,
    disconnect,
  };
  return client as Lgtv2Client;
}

function createUnitAdapter(
  overrides: {
    readonly getSocket?: () => Promise<Lgtv2SpecializedSocket>;
    readonly request?: (uri: string) => Promise<unknown>;
    readonly disconnect?: () => Promise<void>;
    readonly send?: Lgtv2Client['send'];
  } = {},
): { readonly adapter: Lgtv2Adapter; readonly client: Lgtv2Client } {
  let client!: Lgtv2Client;
  const adapter = new Lgtv2Adapter(
    {
      host: 'tv.invalid',
      keyStore: new MemoryKeyStore(),
      requestTimeoutMs: 2_000,
      handshakeTimeoutMs: 500,
      now: () => new Date('2026-09-03T10:00:00.000Z'),
    },
    {
      createClient(options) {
        const emitter = new EventEmitter();
        client = Object.assign(emitter, {
          connected: true,
          urls: ['wss://tv.invalid:3001', 'ws://tv.invalid:3000'],
          request: async (uri: string) => responseForPairing(uri),
          getSocket: async () => ({ send: vi.fn(), close: vi.fn() }),
          wake: async () => undefined,
          disconnect: async () => undefined,
          ...overrides,
        }) as Lgtv2Client;
        queueMicrotask(() => {
          options.saveKey(mockClientKey, (error) => {
            if (error) {
              emitter.emit('error', error);
              return;
            }
            emitter.emit('connecting', 'wss://tv.invalid:3001');
            emitter.emit('connect');
          });
        });
        return client;
      },
    },
  );
  createdAdapters.push(adapter);
  return { adapter, get client() { return client; } };
}

function createHelloAdapter(respond: (client: EventEmitter) => void) {
  let sent!: () => void;
  const gate = new Promise<void>((resolve) => { sent = resolve; });
  const harness = createUnitAdapter({
    request: async (uri) => uri === mockUris.softwareInfo
      ? { major_ver: '03', minor_ver: '40.85' } : responseForPairing(uri),
    send: () => {
      queueMicrotask(() => { respond(harness.client as unknown as EventEmitter); sent(); });
      return 'hello-id';
    },
  });
  return { adapter: harness.adapter, client: () => harness.client as unknown as EventEmitter, sent: gate };
}

async function runAdapterCli(adapter: Lgtv2Adapter, listeners = new Map<string, () => void>()) {
  // Exercise the real CLI, probe, and adapter; only persistence/output are in memory.
  const { runProtocolProbeCli } = await import(new URL('../../../apps/protocol-probe/src/main.js', import.meta.url).href);
  const output: string[] = [];
  const exitCode = await runProtocolProbeCli(['command', '--host', 'tv.invalid', '--data-dir', '.', '--operation', 'button', '--button', 'HOME'], {
    createKeyStore: () => new MemoryKeyStore(), createAdapter: () => adapter, runProbe,
    readReport: async () => undefined, writeReport: async (_directory: string, report: unknown) => report,
    writeMarkdown: async () => '', now: () => new Date('2026-09-03T10:00:00.000Z'),
    stdout: { write: (text: string) => output.push(text) }, stderr: { write: (text: string) => output.push(text) },
    signals: { once: (name: string, listener: () => void) => listeners.set(name, listener), off: (name: string) => listeners.delete(name) },
  });
  return { exitCode, output: output.join('') };
}

function responseForPairing(uri: string): unknown {
  if (uri === mockUris.systemInfo) {
    return mockResponses[mockUris.systemInfo];
  }
  if (uri === mockUris.softwareInfo) {
    return mockResponses[mockUris.softwareInfo];
  }
  if (uri === mockUris.network) {
    return mockResponses[mockUris.network];
  }
  if (uri === mockUris.volume) {
    return mockResponses[mockUris.volume];
  }
  if (uri === mockUris.apps) {
    return mockResponses[mockUris.apps];
  }
  throw new Error(`Unexpected synthetic SSAP URI: ${uri}`);
}
