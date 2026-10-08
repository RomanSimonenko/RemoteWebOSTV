import { afterEach, expect, test } from 'vitest';
import type { TvAdapter } from '@remote-webos-tv/tv-adapter';
import { TvButtonSendError, WebOsError } from '@remote-webos-tv/tv-adapter';
import { createSamsungAdapter, type SamsungAdapterDependencies } from '../src/samsung-adapter.js';
import { connectSample, ControlledSocket, deferred, identitySample, ManualScheduler } from './support/mock-samsung.js';

const adapters: TvAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map((adapter) => adapter.disconnect())); });

function harness(overrides: Partial<SamsungAdapterDependencies> = {}) {
  const scheduler = new ManualScheduler();
  const sockets: ControlledSocket[] = [];
  const urls: string[] = [];
  const socketOptions: unknown[] = [];
  const identities: string[] = [];
  const socketCreated = deferred<ControlledSocket>();
  let nextSocket = socketCreated;
  const adapter = createSamsungAdapter({
    host: 'tv.invalid', allowPairingPrompt: true, handshakeTimeoutMs: 1000, requestTimeoutMs: 500,
    scheduler, acceptHost: (host) => host === 'tv.invalid',
    requestIdentity: async (url) => { identities.push(url); return identitySample; },
    createSocket(url, options) {
      const socket = new ControlledSocket();
      urls.push(url); socketOptions.push(options); sockets.push(socket); nextSocket.resolve(socket);
      return socket;
    }, ...overrides,
  });
  adapters.push(adapter);
  const signal = new AbortController().signal;
  const start = (credential?: string, controller = new AbortController()) => {
    const result = adapter.pair({ host: 'tv.invalid', signal: controller.signal, ...(credential === undefined ? {} : { credential }) });
    // Observe rejection immediately while tests deterministically drive external events.
    result.catch((cause) => socketCreated.reject(cause));
    socketCreated.promise.catch(() => undefined);
    return result;
  };
  const connect = async (credential?: string) => {
    const result = start(credential);
    const socket = await socketCreated.promise;
    socket.open(); socket.message(connectSample());
    await result;
    return socket;
  };
  const expectNextSocket = () => { nextSocket = deferred<ControlledSocket>(); return nextSocket.promise; };
  return { adapter, scheduler, sockets, urls, socketOptions, identities, socketCreated, expectNextSocket, start, connect, signal };
}

test('connectEventCommitsToken', async () => {
  const h = harness();
  const result = h.start();
  const socket = await h.socketCreated.promise;
  socket.open(); socket.message(connectSample());
  await expect(result).resolves.toEqual({
    credential: 'synthetic-token', identity: { model: 'Synthetic Samsung', firmwareVersion: 'synthetic-fw' },
    transport: 'wss:8002', macAddresses: [],
    capabilities: { buttons: true, ssap: false, pointer: false, apps: false, inputs: false, powerOff: false,
      wakeOnLan: false, textInput: false, notifications: false },
  });
  expect(h.identities).toEqual(['http://tv.invalid:8001/api/v2/']);
  expect(h.scheduler.timers.size).toBe(0);
});

test('ownedConnectAllowsBothBooleanHostValuesBecauseSampleDidNotEstablishAValueRule', async () => {
  const h = harness(); const pending = h.start(); const socket = await h.socketCreated.promise;
  const sample = connectSample(); sample.data.clients[0]!.isHost = true;
  socket.open(); socket.message(sample);
  await expect(pending).resolves.toMatchObject({ credential: 'synthetic-token' });
});

test('socketOpenIsNotPairSuccess', async () => {
  const h = harness();
  const result = h.start();
  const socket = await h.socketCreated.promise;
  socket.open(); h.scheduler.fireAll();
  await expect(result).rejects.toMatchObject({ code: 'PAIRING_TIMEOUT' });
  expect(socket.listenerCount).toBe(0);
  expect(socket.terminateCount).toBe(1);
});

test('unauthorizedStopsWithoutReprompt', async () => {
  const h = harness({ allowPairingPrompt: false });
  const result = h.start('saved-synthetic-token');
  const socket = await h.socketCreated.promise;
  socket.open(); socket.message({ event: 'ms.channel.unauthorized' });
  await expect(result).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED' });
  expect(h.urls).toEqual(['wss://tv.invalid:8002/api/v2/channels/samsung.remote.control?name=UmVtb3RlV2ViT1NUVg%3D%3D&token=saved-synthetic-token']);
  expect(h.scheduler.timers.size).toBe(0);
});

test('lateConnectAfterAbortDoesNotCommit', async () => {
  const h = harness();
  const controller = new AbortController();
  const result = h.start(undefined, controller);
  const socket = await h.socketCreated.promise;
  const lateReceive = [...socket.messageListeners][0]!;
  controller.abort();
  lateReceive(JSON.stringify(connectSample('late-synthetic-token')));
  await expect(result).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  await expect(h.adapter.readSnapshot(h.signal)).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  expect(socket.listenerCount).toBe(0);
  expect(h.scheduler.timers.size).toBe(0);
});

test.each([
  ['bad json', '{'], ['no data', { event: 'ms.channel.connect' }],
  ['wrong token type', { ...connectSample(), data: { ...connectSample().data, token: 123 } }],
  ['empty token', connectSample('')],
  ['foreign client', { ...connectSample(), data: { ...connectSample().data, id: 'foreign-client' } }],
  ['foreign name', { event: 'ms.channel.connect', data: { ...connectSample().data,
    clients: [{ ...connectSample().data.clients[0], attributes: { name: 'Zm9yZWlnbg==' } }] } }],
  ['invalid clients', { event: 'ms.channel.connect', data: { ...connectSample().data, clients: [] } }],
  ['missing token initial pairing', { event: 'ms.channel.connect', data: { clients: connectSample().data.clients, id: 'synthetic-client' } }],
])('malformedPayloadFailsSafely: %s', async (_name, payload) => {
  const h = harness();
  const result = h.start();
  const socket = await h.socketCreated.promise;
  socket.open(); socket.message(payload);
  await expect(result).rejects.toMatchObject({ code: 'INVALID_TV_RESPONSE' });
  expect(socket.terminateCount).toBe(1);
  expect(h.scheduler.timers.size).toBe(0);
});

test('disconnectReleasesTimers', async () => {
  const h = harness();
  const result = h.start();
  const socket = await h.socketCreated.promise;
  await h.adapter.disconnect(); await h.adapter.disconnect();
  await expect(result).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  expect(socket.listenerCount).toBe(0);
  expect(h.scheduler.timers.size).toBe(0);
  expect(socket.terminateCount).toBe(1);
});

test('tlsExceptionDoesNotAffectOtherClients', async () => {
  const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const h = harness();
  await h.connect();
  expect(h.socketOptions).toEqual([{ rejectUnauthorized: false }]);
  expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(original);
  expect(h.urls).toEqual(['wss://tv.invalid:8002/api/v2/channels/samsung.remote.control?name=UmVtb3RlV2ViT1NUVg%3D%3D']);
});

test('snapshotDoesNotFabricateLgCapabilitiesOrApiOsVersion', async () => {
  const h = harness(); await h.connect();
  await h.adapter.prepareRemote(h.signal);
  const snapshot = await h.adapter.readSnapshot(h.signal);
  expect(snapshot).toEqual({ connection: 'available', identity: { model: 'Synthetic Samsung', firmwareVersion: 'synthetic-fw' },
    transport: 'wss:8002', capabilities: { buttons: true, ssap: false, pointer: false, apps: false, inputs: false,
      powerOff: false, wakeOnLan: false, textInput: false, notifications: false } });
  expect(h.adapter.launchApp).toBeUndefined(); expect(h.adapter.listApps).toBeUndefined();
  expect(h.adapter.listInputs).toBeUndefined(); expect(h.adapter.powerOff).toBeUndefined(); expect(h.adapter.wake).toBeUndefined();
});

test('buttonFrameMatchesProtocolAndNeverUsesPointer', async () => {
  const h = harness(); const socket = await h.connect();
  await h.adapter.sendButton('UP', h.signal);
  await h.adapter.sendButton('BACK', h.signal);
  expect(socket.frames).toEqual([
    '{"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"KEY_UP","Option":"false","TypeOfRemote":"SendRemoteKey"}}',
    '{"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"KEY_RETURN","Option":"false","TypeOfRemote":"SendRemoteKey"}}',
  ]);
});

test('failedSendIsNeverRetried', async () => {
  const h = harness(); const socket = await h.connect(); socket.deferSend = true;
  const pending = h.adapter.sendButton('UP', h.signal);
  socket.close();
  await expect(pending).rejects.toMatchObject({ delivery: 'unknown', code: 'CONNECTION_LOST' });
  socket.sendCallback?.();
  expect(socket.frames).toHaveLength(1);
  expect(h.urls).toHaveLength(1);
  expect(h.scheduler.timers.size).toBe(0);
});

test('preSendAbortIsNotSent', async () => {
  const h = harness(); const socket = await h.connect();
  const controller = new AbortController(); controller.abort();
  await expect(h.adapter.sendButton('UP', controller.signal)).rejects.toBeInstanceOf(TvButtonSendError);
  await expect(h.adapter.sendButton('UP', controller.signal)).rejects.toMatchObject({ delivery: 'not_sent' });
  expect(socket.frames).toEqual([]);
});

test('localPolicyPrecedesNetwork', async () => {
  const h = harness({ acceptHost: () => false });
  await expect(h.start()).rejects.toBeInstanceOf(WebOsError);
  expect(h.identities).toEqual([]); expect(h.urls).toEqual([]);
});

test('savedTokenAbsenceOfConnectTokenIsExplicitReuseContract', async () => {
  const h = harness({ allowPairingPrompt: false }); const result = h.start('saved-synthetic-token');
  const socket = await h.socketCreated.promise;
  socket.open(); socket.message({ event: 'ms.channel.connect', data: { id: 'synthetic-client', clients: connectSample().data.clients } });
  await expect(result).resolves.toMatchObject({ credential: 'saved-synthetic-token' });
});

test('disconnectDuringHttpAbortsRequestAndIgnoresLateIdentity', async () => {
  const identity = deferred<unknown>(); const started = deferred<AbortSignal>();
  const h = harness({ requestIdentity: async (_url, signal) => { started.resolve(signal); return identity.promise; } });
  const pending = h.start(); const requestSignal = await started.promise; await h.adapter.disconnect();
  identity.resolve(identitySample);
  await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  expect(requestSignal.aborted).toBe(true); expect(h.urls).toEqual([]); expect(h.scheduler.timers.size).toBe(0);
});

test('oldSocketCannotMutateNewConnection', async () => {
  const h = harness(); const old = await h.connect();
  const lateReceive = [...old.messageListeners][0]!;
  await h.adapter.disconnect();
  const nextSocket = h.expectNextSocket(); const pending = h.start('saved-synthetic-token');
  const socket = await nextSocket; socket.open();
  lateReceive(JSON.stringify(connectSample('stale-synthetic-token')));
  socket.message(connectSample('fresh-synthetic-token'));
  await expect(pending).resolves.toMatchObject({ credential: 'fresh-synthetic-token' });
  lateReceive(JSON.stringify({ event: 'ms.channel.unauthorized' }));
  await expect(h.adapter.readSnapshot(h.signal)).resolves.toMatchObject({ connection: 'available' });
  expect(h.urls).toHaveLength(2); expect(old.terminateCount).toBe(1);
});

test('cleanupFailureFromAsyncCloseRemainsVisibleAndCanBeRetried', async () => {
  const h = harness(); const socket = await h.connect();
  const terminate = socket.terminate.bind(socket);
  socket.terminate = () => { throw new Error('Synthetic cleanup failure'); };
  socket.close();
  await expect(h.adapter.disconnect()).rejects.toMatchObject({ cause: { name: 'WebOsCleanupError' } });
  socket.terminate = terminate;
  await h.adapter.disconnect();
  expect(socket.terminateCount).toBe(1);
});

test.each([
  ['malformed', {}], ['wrong OS', { device: { ...identitySample.device, OS: 'webOS' } }],
  ['empty model', { device: { ...identitySample.device, modelName: '' } }],
  ['firmware type', { device: { ...identitySample.device, firmwareVersion: 10 } }],
])('invalidIdentityPreventsSocketAndCredential: %s', async (_name, payload) => {
  const h = harness({ requestIdentity: async () => payload });
  await expect(h.start()).rejects.toMatchObject({ code: 'INVALID_TV_RESPONSE' });
  expect(h.urls).toEqual([]); expect(h.scheduler.timers.size).toBe(0);
});

test('unauthorizedAfterWriteDoesNotReportSentOrRetry', async () => {
  const h = harness(); const socket = await h.connect(); socket.deferSend = true;
  const pending = h.adapter.sendButton('UP', h.signal);
  socket.message({ event: 'ms.channel.unauthorized' });
  await expect(pending).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED', delivery: 'unknown' });
  socket.sendCallback?.();
  expect(socket.frames).toHaveLength(1); expect(h.urls).toHaveLength(1);
});

test('explicitPromptPolicyPreventsTokenlessAutomaticConnect', async () => {
  const h = harness({ allowPairingPrompt: false });
  await expect(h.start()).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED' });
  expect(h.identities).toEqual([]); expect(h.urls).toEqual([]);
});

test('sendTimeoutOrCancellationNeverRepeatsFrame', async () => {
  const h = harness(); const socket = await h.connect(); socket.deferSend = true;
  const pending = h.adapter.sendButton('ENTER', h.signal);
  h.scheduler.fireAll();
  await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST', delivery: 'unknown' });
  socket.sendCallback?.();
  expect(socket.frames).toHaveLength(1); expect(h.urls).toHaveLength(1); expect(socket.listenerCount).toBe(0);
});

test('writeFailureKeepsCleanupFailureEvidenceForTheRealReceiver', async () => {
  const h = harness(); const socket = await h.connect(); socket.deferSend = true;
  const terminate = socket.terminate.bind(socket);
  socket.terminate = () => { throw new Error('Synthetic cleanup failure'); };
  const pending = h.adapter.sendButton('UP', h.signal);
  socket.sendCallback?.(new Error('Synthetic write failure'));
  try {
    const failure = await pending.catch((cause: unknown) => cause) as TvButtonSendError;
    expect(failure.delivery).toBe('unknown');
    expect(failure.cause).toMatchObject({ cause: { name: 'WebOsCleanupError' } });
  } finally { socket.terminate = terminate; await h.adapter.disconnect(); }
});
