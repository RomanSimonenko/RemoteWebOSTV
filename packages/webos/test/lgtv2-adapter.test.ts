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
} from '../src/lgtv2-types.js';
import type { ClientKeyStore } from '../src/key-store.js';
import { MockWebOsTv } from './support/mock-webos-tv.js';
import { mockClientKey } from './support/fixtures.js';

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
} {
  const port = Number(new URL(mock.url).port);
  const configuredClients: Lgtv2ClientOptions[] = [];
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
        return createLgtv2Client({
          ...options,
          host: '127.0.0.1',
          ports: { secure: port, insecure: port },
          verifyCert: false,
        });
      },
    },
  );
  createdAdapters.push(adapter);
  return { adapter, configuredClients };
}

function pair(adapter: Lgtv2Adapter, signal = new AbortController().signal) {
  return adapter.pair({ host: 'tv.invalid', signal });
}

describe('Lgtv2Adapter', () => {
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
    request: async () => new Promise<never>(() => undefined),
    getSocket: async () => new Promise<never>(() => undefined),
    disconnect,
  };
  return client as Lgtv2Client;
}
