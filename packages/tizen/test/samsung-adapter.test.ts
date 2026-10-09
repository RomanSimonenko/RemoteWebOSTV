import { EventEmitter, getEventListeners } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import type { TvAdapter } from '@remote-webos-tv/tv-adapter';
import { TvButtonSendError, TvPowerSendError, WebOsError } from '@remote-webos-tv/tv-adapter';
import * as parsers from '../src/response-parsers.js';
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
    capabilities: { buttons: true, ssap: false, pointer: false, apps: false, inputs: false, powerOff: true,
      wakeOnLan: false, textInput: false, notifications: false },
  });
  expect(h.identities).toEqual(['http://tv.invalid:8001/api/v2/']);
  expect(h.scheduler.timers.size).toBe(0);
});

test('optional SDB failure preserves paired control and does not mutate identity', async () => {
  const sdb = Object.assign(new EventEmitter(), { write: () => true, destroy: () => {} });
  const h = harness({ createSdbSocket: () => sdb }); await h.connect();
  const pending = h.adapter.readPlatformVersion!(h.signal);
  sdb.emit('error', new Error('synthetic private network detail'));
  expect(await pending).toEqual({ diagnostic: { operation: 'sdb_capability', code: 'request_rejected' } });
  expect((await h.adapter.readSnapshot(h.signal)).identity?.platformVersion).toBeUndefined();
  await expect(h.adapter.sendButton('HOME', h.signal)).resolves.toBeUndefined();
});

test('disconnect aborts optional SDB transport and releases its listeners', async () => {
  let destroyed = false;
  const sdb = Object.assign(new EventEmitter(), { write: () => true, destroy: () => { destroyed = true; } });
  const h = harness({ createSdbSocket: () => sdb }); await h.connect();
  const pending = h.adapter.readPlatformVersion!(h.signal);
  await h.adapter.disconnect();
  await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  expect(destroyed).toBe(true); expect(sdb.eventNames()).toEqual([]); expect(h.scheduler.timers.size).toBe(0);
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
      powerOff: true, wakeOnLan: false, textInput: false, notifications: false } });
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

test.each(['success', 'failure'] as const)('postWriteAbortIsUnknownAndLateCallbackCannotSettleAgain: %s', async (late) => {
  const h = harness(); const socket = await h.connect(); socket.deferSend = true;
  const controller = new AbortController();
  const pending = h.adapter.sendButton('UP', controller.signal);
  const lateCallback = socket.sendCallback!;
  expect(socket.frames).toHaveLength(1); expect(h.scheduler.timers.size).toBe(1);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ delivery: 'unknown', code: 'CONNECTION_LOST' });
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  expect(h.scheduler.timers.size).toBe(0);
  lateCallback(late === 'failure' ? new Error('Synthetic late write failure') : undefined);
  await expect(pending).rejects.toMatchObject({ delivery: 'unknown', code: 'CONNECTION_LOST' });
  await h.adapter.disconnect();
  expect(socket.frames).toHaveLength(1); expect(h.urls).toHaveLength(1);
  expect(socket.listenerCount).toBe(0); expect(socket.terminateCount).toBe(1);
  expect(h.scheduler.timers.size).toBe(0);
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

test.each([
  ['on', 'on'], ['standby', 'standby'], [undefined, 'unknown'], ['', 'unknown'],
  ['ON', 'unknown'], ['off', 'unknown'], [true, 'unknown'], [0, 'unknown'], [null, 'unknown'],
])('power parser accepts only exact observed states: %s', (value, expected) => {
  expect(parsers.parseSamsungPowerState({ ...identitySample, device: { ...identitySample.device, PowerState: value } })).toBe(expected);
});

test.each([null, [], {}, { device: null }, { device: [] }])('power parser rejects malformed envelope safely: %s', (payload) => {
  try { parsers.parseSamsungPowerState(payload); throw new Error('Expected malformed envelope rejection'); }
  catch (cause) {
    expect(cause).toBeInstanceOf(WebOsError);
    expect(cause).toMatchObject({ code: 'INVALID_TV_RESPONSE', message: 'Invalid Samsung protocol response' });
    expect((cause as Error).cause).toBeUndefined();
  }
});

function powerHarness(states: unknown[]) {
  const h = harness({ requestIdentity: async () => {
    const state = states.shift();
    return { ...identitySample, device: { ...identitySample.device, PowerState: state } };
  } });
  const request = { host: 'tv.invalid', credential: 'saved-synthetic-token', signal: h.signal };
  return { ...h, request };
}

// Drive microtask-only HTTP work without sleeping or advancing transport deadlines.
async function drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test.each(['on', 'standby'] as const)('already desired power %s opens no socket', async (desired) => {
  const h = powerHarness([desired]);
  await expect(h.adapter.setPowerState!(desired, h.request)).resolves.toEqual({ delivery: 'not_sent' });
  expect(h.urls).toEqual([]); expect(h.scheduler.timers.size).toBe(0);
});

test('power HTTP observation works without WSS and releases abort listeners', async () => {
  const h = powerHarness(['standby']); const controller = new AbortController();
  await expect(h.adapter.readPowerState!(controller.signal)).resolves.toBe('standby');
  expect(h.urls).toEqual([]); expect(h.scheduler.timers.size).toBe(0);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test.each(['on', 'unknown'] as const)('post-handshake %s prevents toggle', async (postState) => {
  const h = powerHarness(['standby', 'standby', postState]);
  const pending = h.adapter.setPowerState!('on', h.request);
  const caught = pending.catch((cause: unknown) => cause);
  const socket = await h.socketCreated.promise; socket.open(); socket.message(connectSample());
  if (postState === 'on') expect(await caught).toMatchObject({ delivery: 'not_sent', pairing: { credential: 'synthetic-token' } });
  else expect(await caught).toMatchObject({ delivery: 'not_sent', code: 'INVALID_TV_RESPONSE' });
  expect(socket.frames).toEqual([]);
  expect(new URL(h.urls[0]!).searchParams.get('token')).toBe('saved-synthetic-token');
});

test.each(['on', 'standby'] as const)('desired %s sends one exact power toggle on owned socket', async (desired) => {
  const opposite = desired === 'on' ? 'standby' : 'on';
  const h = powerHarness(['on', opposite, opposite]); const socket = await h.connect();
  await expect(h.adapter.setPowerState!(desired, h.request)).resolves.toEqual({ delivery: 'sent' });
  expect(h.urls).toHaveLength(1);
  expect(socket.frames).toEqual(['{"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"KEY_POWER","Option":"false","TypeOfRemote":"SendRemoteKey"}}']);
});

test('power cannot initiate tokenless pairing even when prompt policy allows pairing', async () => {
  const h = powerHarness(['standby']);
  await expect(h.adapter.setPowerState!('on', { host: 'tv.invalid', signal: h.signal })).rejects.toMatchObject({ delivery: 'not_sent', code: 'AUTHORIZATION_FAILED' });
  expect(h.urls).toEqual([]);
});

test('unknown initial power never opens socket', async () => {
  const h = powerHarness(['unknown']);
  await expect(h.adapter.setPowerState!('on', h.request)).rejects.toMatchObject({ delivery: 'not_sent', code: 'INVALID_TV_RESPONSE' });
  expect(h.urls).toEqual([]);
});

test('aborted power operation before read is not sent', async () => {
  const h = powerHarness(['standby']); const controller = new AbortController(); controller.abort();
  const failure = await h.adapter.setPowerState!('on', { ...h.request, signal: controller.signal }).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(TvPowerSendError); expect(failure).toMatchObject({ delivery: 'not_sent' });
  expect(h.urls).toEqual([]);
});

test.each(['timeout', 'close', 'abort', 'cleanup'] as const)('power %s after write is unknown and never repeats', async (boundary) => {
  const h = powerHarness(['on', 'standby', 'standby']); const socket = await h.connect(); socket.deferSend = true;
  const controller = new AbortController();
  const pending = h.adapter.setPowerState!('on', { ...h.request, signal: controller.signal });
  const caught = pending.catch((cause: unknown) => cause);
  await drain(); expect(socket.frames).toHaveLength(1);
  const lateCallback = socket.sendCallback!; const terminate = socket.terminate.bind(socket);
  if (boundary === 'cleanup') socket.terminate = () => { throw new Error('Synthetic cleanup failure'); };
  if (boundary === 'timeout') h.scheduler.fireAll();
  else if (boundary === 'abort') controller.abort();
  else socket.close();
  const failure = await caught;
  expect(failure).toBeInstanceOf(TvPowerSendError); expect(failure).toMatchObject({ delivery: 'unknown', code: 'CONNECTION_LOST' });
  if (boundary === 'cleanup') expect(failure).toMatchObject({ cause: { cause: { name: 'WebOsCleanupError' } } });
  lateCallback(); expect(socket.frames).toHaveLength(1); expect(h.urls).toHaveLength(1);
  socket.terminate = terminate; await h.adapter.disconnect();
  expect(h.scheduler.timers.size).toBe(0); expect(socket.listenerCount).toBe(0);
});

test.each(['abort', 'timeout', 'failure'] as const)('independent power HTTP %s rejects and ignores late response', async (boundary) => {
  const payload = deferred<unknown>(); const started = deferred<AbortSignal>();
  const h = harness({ requestIdentity: async (_url, signal) => { started.resolve(signal); return payload.promise; } });
  const controller = new AbortController(); const pending = h.adapter.readPowerState!(controller.signal);
  const caught = pending.catch((cause: unknown) => cause); const child = await started.promise;
  if (boundary === 'abort') controller.abort();
  else if (boundary === 'timeout') h.scheduler.fireAll();
  else payload.reject(new Error('Synthetic HTTP failure'));
  expect(await caught).toMatchObject({ code: boundary === 'abort' ? 'CONNECTION_LOST' : 'NETWORK_UNREACHABLE' });
  payload.resolve(identitySample); await drain();
  expect(child.aborted).toBe(true); expect(h.scheduler.timers.size).toBe(0);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0); expect(h.urls).toEqual([]);
});

test('power observation and already-desired operation enforce local host policy before HTTP', async () => {
  const h = harness({ acceptHost: () => false });
  await expect(h.adapter.readPowerState!(h.signal)).rejects.toMatchObject({ code: 'NETWORK_UNREACHABLE' });
  await expect(h.adapter.setPowerState!('on', { host: 'tv.invalid', signal: h.signal })).rejects.toMatchObject({ code: 'NETWORK_UNREACHABLE', delivery: 'not_sent' });
  expect(h.identities).toEqual([]); expect(h.urls).toEqual([]);
});

test('power mismatched host rejects before HTTP', async () => {
  const h = harness();
  await expect(h.adapter.setPowerState!('on', { host: 'other.invalid', credential: 'synthetic-token', signal: h.signal })).rejects.toMatchObject({ code: 'NETWORK_UNREACHABLE', delivery: 'not_sent' });
  expect(h.identities).toEqual([]); expect(h.urls).toEqual([]);
});

test.each(['', '   ', 10])('invalid saved power credential never opens WSS: %s', async (credential) => {
  const h = powerHarness(['standby']);
  await expect(h.adapter.setPowerState!('on', { ...h.request, credential: credential as string })).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED', delivery: 'not_sent' });
  expect(h.urls).toEqual([]);
});

test('power abort during handshake releases socket and ignores late authorization', async () => {
  const h = powerHarness(['standby', 'standby']); const controller = new AbortController();
  const pending = h.adapter.setPowerState!('on', { ...h.request, signal: controller.signal });
  const caught = pending.catch((cause: unknown) => cause); const socket = await h.socketCreated.promise;
  const late = [...socket.messageListeners][0]!; controller.abort(); late(JSON.stringify(connectSample()));
  expect(await caught).toMatchObject({ delivery: 'not_sent', code: 'CONNECTION_LOST' });
  expect(socket.frames).toEqual([]); expect(socket.listenerCount).toBe(0); expect(h.scheduler.timers.size).toBe(0);
});

test('power abort on second read cannot write a frame after late HTTP', async () => {
  const second = deferred<unknown>(); const started = deferred<AbortSignal>(); let reads = 0;
  const h = harness({ requestIdentity: async (_url, signal) => {
    reads++;
    if (reads === 3) { started.resolve(signal); return second.promise; }
    return { ...identitySample, device: { ...identitySample.device, PowerState: 'standby' } };
  } });
  const socket = await h.connect(); const controller = new AbortController();
  const pending = h.adapter.setPowerState!('on', { host: 'tv.invalid', signal: controller.signal });
  const caught = pending.catch((cause: unknown) => cause); const child = await started.promise;
  controller.abort(); second.resolve(identitySample);
  expect(await caught).toMatchObject({ delivery: 'not_sent', code: 'CONNECTION_LOST' });
  expect(child.aborted).toBe(true); expect(socket.frames).toEqual([]); expect(h.scheduler.timers.size).toBe(0);
});

test('disconnect cancels independent power HTTP and late response cannot revive it', async () => {
  const payload = deferred<unknown>(); const started = deferred<AbortSignal>();
  const h = harness({ requestIdentity: async (_url, signal) => { started.resolve(signal); return payload.promise; } });
  const pending = h.adapter.readPowerState!(h.signal); const caught = pending.catch((cause: unknown) => cause);
  const child = await started.promise; await h.adapter.disconnect(); payload.resolve(identitySample);
  expect(await caught).toMatchObject({ code: 'CONNECTION_LOST' }); expect(child.aborted).toBe(true);
  expect(h.scheduler.timers.size).toBe(0); expect(h.urls).toEqual([]);
});

test('fresh power handshake persists rotated credential before second observation and toggle', async () => {
  let reads = 0; let persisted = false;
  const h = harness({ requestIdentity: async () => {
    reads++;
    if (reads === 3) expect(persisted).toBe(true);
    return { ...identitySample, device: { ...identitySample.device, PowerState: 'standby' } };
  } });
  const pending = h.adapter.setPowerState!('on', { host: 'tv.invalid', credential: 'saved-synthetic-token', signal: h.signal,
    onPaired: async (pairing) => {
      expect(pairing.credential).toBe('rotated-synthetic-token');
      expect(reads).toBe(2); expect(h.sockets[0]!.frames).toEqual([]); persisted = true;
    },
  });
  const socket = await h.socketCreated.promise; socket.open(); socket.message(connectSample('rotated-synthetic-token'));
  await expect(pending).resolves.toMatchObject({ delivery: 'sent' }); expect(persisted).toBe(true);
});

test('power credential persistence failure is causal not_sent with zero frames', async () => {
  const h = powerHarness(['standby', 'standby', 'standby']); const failure = new WebOsError('KEY_STORE_WRITE_FAILED', 'Synthetic persistence failure');
  const pending = h.adapter.setPowerState!('on', { ...h.request, onPaired: async () => { throw failure; } });
  const caught = pending.catch((cause: unknown) => cause);
  const socket = await h.socketCreated.promise; socket.open(); socket.message(connectSample());
  expect(await caught).toMatchObject({ delivery: 'not_sent', code: 'KEY_STORE_WRITE_FAILED', cause: failure });
  expect(socket.frames).toEqual([]); expect(h.scheduler.timers.size).toBe(0);
});

test('abort during deferred power credential persistence prevents late completion from toggling', async () => {
  const h = powerHarness(['standby', 'standby', 'standby']); const controller = new AbortController();
  const entered = deferred<void>(); const persisted = deferred<void>();
  const pending = h.adapter.setPowerState!('on', { ...h.request, signal: controller.signal,
    onPaired: async () => { entered.resolve(); await persisted.promise; },
  });
  const caught = pending.catch((cause: unknown) => cause);
  const socket = await h.socketCreated.promise; socket.open(); socket.message(connectSample());
  await entered.promise; controller.abort(); persisted.resolve();
  expect(await caught).toMatchObject({ delivery: 'not_sent', code: 'CONNECTION_LOST' });
  expect(socket.frames).toEqual([]); expect(h.scheduler.timers.size).toBe(0);
});

test('owned ready power socket does not invoke fresh-connection persistence callback', async () => {
  const h = powerHarness(['on', 'standby', 'standby']); const socket = await h.connect(); let calls = 0;
  await expect(h.adapter.setPowerState!('on', { ...h.request, onPaired: async () => { calls++; } })).resolves.toEqual({ delivery: 'sent' });
  expect(calls).toBe(0); expect(socket.frames).toHaveLength(1);
});
