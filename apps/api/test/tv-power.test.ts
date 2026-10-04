import { describe, expect, test } from 'vitest';
import { tvPowerStateSchema } from '@remote-webos-tv/contracts';
import { Lgtv2Adapter, sendWakeOnLan, TvPowerSendError, WebOsError, type WakeSocket } from '@remote-webos-tv/webos';
import { EventEmitter } from 'node:events';
import { barrier, ControlledAdapter, drain, harness, pairing, snapshot, succeed } from './support/tv-harness.js';

const id = '15e082b2-de7e-4d86-a049-19c7448264f1';
const off = { id, action: 'power_off', confirm: true } as const;
const wake = { id, action: 'wake' } as const;
async function connected() {
  const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!); return h;
}

describe('owned TV power operations', () => {
  test.each([true, false])('real UDP close failure stays unsafe after adapter disconnect succeeds: send failure %j', async (sendFails) => {
    const base = harness(true); base.repository.replace({ ...base.repository.load()!, macAddress: '02:00:00:00:00:01' });
    const packets: Buffer[] = []; const adapters: Lgtv2Adapter[] = [];
    const socket = Object.assign(new EventEmitter(), {
      bind(callback: () => void) { callback(); }, setBroadcast() {},
      send(packet: Buffer, _offset: number, _length: number, _port: number, _address: string, callback: (error?: Error | null) => void) {
        packets.push(Buffer.from(packet)); callback(sendFails ? new WebOsError('CONNECTION_LOST', 'synthetic UDP send failure') : undefined);
      }, close() { throw new Error('synthetic UDP close failure'); },
    }) as WakeSocket;
    const h = harness(true, { repository: base.repository, createAdapter(host, keyStore, requestTimeoutMs, allowPairingPrompt) {
      const adapter = new Lgtv2Adapter({ host, keyStore, requestTimeoutMs, handshakeTimeoutMs: requestTimeoutMs, allowPairingPrompt, now: () => new Date(0) }, {
        wake: (macs, signal) => sendWakeOnLan(macs, signal, { createSocket: () => socket, schedule(callback) { callback(); return undefined; }, clearSchedule() {} }),
      }); adapters.push(adapter); return adapter;
    } });
    h.service.startPower(wake, 'owner'); await drain();
    expect.soft(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'unknown', error: { code: sendFails ? 'CONNECTION_LOST_CLEANUP_FAILED' : 'UNKNOWN_CLEANUP_FAILED' } });
    expect(packets).toHaveLength(sendFails ? 1 : 3);
    await expect(adapters[0]!.disconnect()).resolves.toBeUndefined();
    expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'CLEANUP_FAILED' }));
    expect(() => h.service.setMac(null)).toThrowError(expect.objectContaining({ code: 'CLEANUP_FAILED' }));
    expect(() => h.service.start({ action: 'repair' })).toThrowError(expect.objectContaining({ code: 'CLEANUP_FAILED' }));
    await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' }); await base.service.close();
  });
  test('off cancelled before its worker preserves the verified connection and sends nothing', async () => {
    const h = await connected(); h.service.startPower(off, 'owner'); await h.service.cancelOwnedPower('owner');
    expect(h.adapters[0]!.powerOffs).toBe(0); expect(h.service.powerState()).toMatchObject({ canPowerOff: true, operation: { status: 'cancelled', delivery: 'not_sent' } });
    expect(h.service.remoteState()).toEqual({ enabled: true, reason: null }); await h.service.close();
  });

  test('off cleanup failure is visible and fail-closed even after observed unavailability', async () => {
    const h = await connected(); const adapter = h.adapters[0]!; adapter.readResult = barrier();
    adapter.disconnectResult = Promise.reject(new Error('synthetic cleanup')); h.service.startPower(off, 'owner'); await drain();
    adapter.readResult.reject(new WebOsError('CONNECTION_LOST', 'synthetic unavailable')); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'sent', error: { code: 'CLEANUP_FAILED' } });
    expect((await h.service.status()).connection).toBe('unavailable');
    expect(() => h.service.setMac(null)).toThrowError(expect.objectContaining({ code: 'CLEANUP_FAILED' }));
    await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
  });
  test('observed off unavailability stays succeeded while its owned cleanup exceeds the observation budget', async () => {
    const h = await connected(); const adapter = h.adapters[0]!; const cleanup = barrier<void>(); adapter.disconnectResult = cleanup.promise; adapter.readResult = barrier();
    h.service.startPower(off, 'owner'); await drain(); adapter.readResult.reject(new WebOsError('CONNECTION_LOST', 'synthetic')); await drain();
    expect(h.service.powerState().operation?.status).toBe('succeeded'); h.scheduler.advance(5_000); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'succeeded', delivery: 'sent' });
    expect(() => h.service.start({ action: 'reconnect' })).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    let closed = false; const closing = h.service.close().then(() => { closed = true; }); await drain(); expect(closed).toBe(false); cleanup.resolve(); await closing;
  });
  test('pre-send wake failure closes its never-connected adapter and polling does not infer a lost connection', async () => {
    const base = harness(true); base.repository.replace({ ...base.repository.load()!, macAddress: '02:00:00:00:00:01' });
    const adapters: typeof base.adapters = [];
    const f = harness(true, { repository: base.repository, createAdapter(_host, staging) {
      const adapter = new ControlledAdapter(staging); adapter.wakeResult = Promise.reject(new TvPowerSendError('NETWORK_UNREACHABLE', 'not_sent', 'synthetic bind rejection')); adapters.push(adapter); return adapter;
    } });
    f.service.startPower(wake, 'owner'); await drain();
    expect(f.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'not_sent', error: { code: 'NETWORK_UNREACHABLE' } });
    expect(adapters[0]!.closed).toBe(true);
    for (let poll = 0; poll < 3; poll++) await f.service.status(); await drain(); expect(adapters).toHaveLength(1);
    await f.service.close(); await base.service.close();
  });

  test.each(['AUTHORIZATION_FAILED', 'INVALID_TV_RESPONSE'] as const)('off observation %s is failure and never physical-off success', async (code) => {
    const h = await connected(); h.adapters[0]!.readResult = barrier(); h.service.startPower(off, 'owner'); await drain();
    h.adapters[0]!.readResult.reject(new WebOsError(code, 'synthetic')); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'sent', error: { code } });
    h.scheduler.advance(60_000); await h.service.status(); await drain(); expect(h.adapters).toHaveLength(1); await h.service.close();
  });

  test('wake timeout waits for owned transport close before allowing replacement and never repeats WOL', async () => {
    const base = harness(true); base.repository.replace({ ...base.repository.load()!, macAddress: '02:00:00:00:00:01' });
    const pending = barrier<void>(); const adapters: typeof base.adapters = [];
    const h = harness(true, { repository: base.repository, recoveryTimeoutMs: 1_000, createAdapter(_host, staging) {
      const adapter = new ControlledAdapter(staging); adapter.wakeResult = pending.promise; adapters.push(adapter); return adapter;
    } });
    h.service.startPower(wake, 'owner'); await drain(); h.scheduler.advance(1_000); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'unknown', error: { code: 'RECOVERY_TIMEOUT' } });
    expect(() => h.service.setMac(null)).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    let closed = false; const closing = h.service.close().then(() => { closed = true; }); await drain(); expect(closed).toBe(false);
    pending.resolve(); await closing; expect(adapters).toHaveLength(1); expect(adapters[0]!.wakes).toHaveLength(1); await base.service.close();
  });
  test('MAC normalization preserves the encrypted key and obeys the common gate', async () => {
    const h = harness(true); const key = h.repository.load()!.encryptedClientKey;
    expect(h.service.setMac('02-ab-cd-ef-00-01')).toMatchObject({ mac: '02:AB:CD:EF:00:01', canWake: true });
    expect(h.repository.load()!.encryptedClientKey).toEqual(key);
    expect(() => h.service.setMac('invalid')).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    h.service.startPower(wake, 'owner');
    expect(() => h.service.setMac(null)).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    expect(() => h.service.start({ action: 'repair' })).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    expect(h.service.remoteState()).toEqual({ enabled: false, reason: 'BUSY' });
    await h.service.close();
  });

  test('wake requires a saved MAC, sends one adapter operation and blocks concurrent admission', async () => {
    const h = harness(true);
    expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'WOL_NOT_CONFIGURED' }));
    h.service.setMac('02:00:00:00:00:01');
    const operation = h.service.startPower(wake, 'owner');
    expect(operation).toMatchObject({ id, action: 'wake', phase: 'sending', delivery: 'not_sent', status: 'running' });
    expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    await drain();
    expect(h.adapters[0]!.wakes).toEqual([['02:00:00:00:00:01']]);
    await drain();
    expect(h.service.powerState().operation).toMatchObject({ delivery: 'sent', phase: 'connecting' });
    await succeed(h.adapters[1]!);
    expect(h.service.powerState().operation).toMatchObject({ status: 'succeeded', phase: 'finished', delivery: 'sent' });
    expect(tvPowerStateSchema.safeParse(h.service.powerState()).success).toBe(true);
    expect((await h.service.status()).connection).toBe('available');
    await h.service.close();
  });

  test('power off rejects unavailable, unsupported, probe and command ownership before send', async () => {
    const h = harness(true);
    expect(() => h.service.startPower(off, 'owner')).toThrowError(expect.objectContaining({ code: 'TV_UNAVAILABLE' }));
    h.service.start({ action: 'reconnect' }); await drain(); const adapter = h.adapters[0]!;
    adapter.pairResult.resolve(pairing); await adapter.enteredRead.promise;
    adapter.readResult.resolve({ ...snapshot, capabilities: { ...snapshot.capabilities, powerOff: false } }); await drain();
    expect(() => h.service.startPower(off, 'owner')).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
    adapter.readResult = barrier(); const reading = h.service.status(); await drain();
    expect(() => h.service.startPower(off, 'owner')).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    adapter.readResult.resolve(snapshot); await reading;
    const sent = barrier<void>(); adapter.sendResult = sent.promise;
    const sending = h.service.sendCommand({ id, button: 'UP' }, new AbortController().signal); await drain();
    expect(() => h.service.startPower(off, 'owner')).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    sent.resolve(); await sending; expect(adapter.powerOffs).toBe(0); await h.service.close();
  });

  test('power off succeeds only after probe unavailability and suppresses automatic recovery', async () => {
    const h = await connected(); const adapter = h.adapters[0]!; adapter.readResult = barrier();
    h.service.startPower(off, 'owner'); await drain();
    expect(adapter.powerOffs).toBe(1);
    expect(h.service.powerState().operation).toMatchObject({ status: 'running', delivery: 'sent' });
    adapter.readResult.reject(new WebOsError('CONNECTION_LOST', 'synthetic network failure')); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'succeeded', delivery: 'sent', phase: 'finished' });
    expect((await h.service.status()).connection).toBe('unavailable');
    h.scheduler.advance(60_000); await h.service.status(); await drain(); expect(h.adapters).toHaveLength(1);
    h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[1]!); await h.service.close();
  });

  test('power off available probes use one second cooldown and expire unconfirmed at five seconds', async () => {
    const h = await connected(); const adapter = h.adapters[0]!;
    h.service.startPower(off, 'owner'); await drain(); expect(adapter.reads).toBe(2);
    h.scheduler.advance(999); await drain(); expect(adapter.reads).toBe(2);
    h.scheduler.advance(1); await drain(); expect(adapter.reads).toBe(3);
    h.scheduler.advance(4_000); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'sent', error: { code: 'POWER_OFF_UNCONFIRMED' } });
    expect((await h.service.status()).connection).toBe('available');
    expect(adapter.powerOffs).toBe(1); await h.service.close();
  });

  test('ambiguous off cancellation publishes unknown but retains ownership until send and cleanup settle', async () => {
    const h = await connected(); const adapter = h.adapters[0]!;
    const pending = barrier<void>(); const cleanup = barrier<void>(); adapter.powerResult = pending.promise; adapter.disconnectResult = cleanup.promise;
    h.service.startPower(off, 'owner'); await drain();
    expect(() => h.service.cancelPower(id, 'other')).toThrowError(expect.objectContaining({ code: 'OPERATION_NOT_FOUND' }));
    h.service.cancelPower(id, 'owner'); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'cancelled', delivery: 'unknown' });
    expect(() => h.service.start({ action: 'reconnect' })).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    let cancelled = false; const cancellation = h.service.cancelOwnedPower('owner').then(() => { cancelled = true; }); await drain(); expect(cancelled).toBe(false);
    pending.resolve(); await drain(); expect(cancelled).toBe(false);
    cleanup.resolve(); await cancellation;
    h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[1]!); await h.service.close();
  });

  test('off timeout without ACK is unknown and late completion cannot publish success', async () => {
    const h = await connected(); const adapter = h.adapters[0]!; const pending = barrier<void>(); adapter.powerResult = pending.promise;
    h.service.startPower(off, 'owner'); await drain(); h.scheduler.advance(5_000); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'unknown' });
    expect(() => h.service.setMac(null)).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    pending.resolve(); await drain(); expect(h.service.powerState().operation?.status).toBe('failed');
    h.scheduler.advance(60_000); await h.service.status(); await drain(); expect(adapter.powerOffs).toBe(1); expect(h.adapters).toHaveLength(1); await h.service.close();
  });

  test('legacy cancellation cannot bypass the power owner and pre-worker wake cancellation sends nothing', async () => {
    const h = harness(true); h.service.setMac('02:00:00:00:00:01'); h.service.startPower(wake, 'owner');
    expect(() => h.service.cancel(id)).toThrowError(expect.objectContaining({ code: 'OPERATION_NOT_FOUND' }));
    const unrelated = h.service.cancelOwnedPower('other'); expect(h.service.powerState().operation?.status).toBe('running');
    await h.service.cancelOwnedPower('owner'); await unrelated;
    expect(h.adapters).toHaveLength(0); expect(h.service.powerState()).toMatchObject({ canWake: true, operation: { status: 'cancelled', delivery: 'not_sent' } });
    await h.service.close();
  });
});
