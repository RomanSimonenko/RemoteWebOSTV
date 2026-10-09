import { describe, expect, test } from 'vitest';
import { tvPowerOperationSchema, tvPowerStateSchema, type TvStatusResponse } from '@remote-webos-tv/contracts';
import { Lgtv2Adapter, sendWakeOnLan, TvPowerSendError, WebOsError, type WakeSocket } from '@remote-webos-tv/webos';
import { EventEmitter } from 'node:events';
import { barrier, ControlledAdapter, drain, harness, pairing, snapshot, succeed } from './support/tv-harness.js';
import type { TvPowerSetRequest, TvPowerSetResult } from '@remote-webos-tv/tv-adapter';
import type { TvServiceDependencies } from '../src/tv/service.js';

const id = '15e082b2-de7e-4d86-a049-19c7448264f1';
const off = { id, action: 'power_off', confirm: true } as const;
const wake = { id, action: 'wake' } as const;
async function samsung(initial: 'on' | 'standby' = 'on', overrides: Partial<TvServiceDependencies> = {}) {
  const base = harness(true); base.repository.replace({ ...base.repository.load()!, platform: 'tizen' });
  let observed: 'on' | 'standby' | 'unknown' = initial;
  let sendFailure: unknown;
  let delivery: 'sent' | 'not_sent' = 'sent';
  let setOverride: ((desired: 'on' | 'standby', request: TvPowerSetRequest) => Promise<TvPowerSetResult>) | undefined;
  let readOverride: (() => Promise<'on' | 'standby' | 'unknown'>) | undefined;
  const powerAdapters: ControlledAdapter[] = [];
  const requests: unknown[] = [];
  const h = harness(true, { repository: base.repository, recoveryTimeoutMs: 1_000, createAdapter(_host, staging) {
    const adapter = new ControlledAdapter(staging);
    powerAdapters.push(adapter);
    adapter.pair = async (request) => { adapter.pairs++; adapter.enteredPair.resolve(request); return pairing; };
    adapter.readSnapshot = async () => snapshot;
    return Object.assign(adapter, {
      readPowerState: async () => readOverride ? readOverride() : observed,
      setPowerState: async (desired: 'on' | 'standby', request: TvPowerSetRequest) => {
        requests.push(request);
        if (setOverride) return setOverride(desired, request);
        if (sendFailure) throw sendFailure;
        observed = desired;
        return { delivery };
      },
    });
  }, ...overrides });
  await h.service.status();
  return { ...h, requests, base, powerAdapters, observe(value: typeof observed) { observed = value; }, fail(cause: unknown) { sendFailure = cause; }, noSend() { delivery = 'not_sent'; }, set(fn: NonNullable<typeof setOverride>) { setOverride = fn; }, read(fn: NonNullable<typeof readOverride>) { readOverride = fn; } };
}
async function connected() {
  const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!); return h;
}

describe('owned TV power operations', () => {
  test('wake expires after twenty seconds without repeating the power command', async () => {
    const h = await samsung('standby', { recoveryTimeoutMs: 60_000 });
    try {
      h.set(async () => ({ delivery: 'sent' }));
      h.service.startPower(wake, 'owner'); await drain();
      h.scheduler.advance(19_999); await drain();
      expect(h.service.powerState().operation).toMatchObject({ status: 'running' });
      h.scheduler.advance(1); await drain();
      expect(h.service.powerState().operation).toMatchObject({ status: 'failed', error: { code: 'RECOVERY_TIMEOUT' } });
      expect(h.requests).toHaveLength(1);
    } finally { await h.service.close(); await h.base.service.close(); }
  });
  test.each(['success', 'deadline'] as const)('Samsung wake keeps a retryable handshake timeout nonterminal until %s', async outcome => {
    const base = harness(true);
    base.repository.replace({ ...base.repository.load()!, platform: 'tizen' });
    let state: 'on' | 'standby' = 'standby';
    let pairs = 0;
    let sends = 0;
    const h = harness(true, { repository: base.repository, recoveryTimeoutMs: 20_000, createAdapter(_host, staging) {
      return Object.assign(new ControlledAdapter(staging), {
        readPowerState: async () => state,
        setPowerState: async () => { sends++; state = 'on'; return { delivery: 'sent' as const }; },
        pair: async () => {
          if (++pairs === 1 || outcome === 'deadline') throw new WebOsError('PAIRING_TIMEOUT', 'synthetic slow startup handshake');
          return pairing;
        },
        readSnapshot: async () => snapshot,
      });
    } });
    try {
      await h.service.status();
      h.service.startPower(wake, 'owner'); await drain();
      expect(h.service.powerState().operation).toMatchObject({ status: 'running', delivery: 'sent' });
      expect((await h.service.status()).error).toBeUndefined();
      h.scheduler.advance(outcome === 'success' ? 1_000 : 20_000); await drain();
      if (outcome === 'success') {
        expect(h.service.powerState().operation).toMatchObject({ status: 'succeeded' });
        expect(h.service.remoteState().enabled).toBe(true);
      } else {
        expect(h.service.powerState().operation).toMatchObject({ status: 'failed', error: { code: 'RECOVERY_TIMEOUT' } });
        expect(h.service.remoteState().enabled).toBe(false);
      }
      expect(sends).toBe(1);
    } finally { await h.service.close(); await base.service.close(); }
  });
  test('Samsung physical wake after intentional shutdown reconnects once without toggling power', async () => {
    const h = await samsung();
    try {
      h.service.start({ action: 'reconnect' }); await drain();
      h.service.startPower(off, 'owner'); await drain();
      h.powerAdapters.at(-1)!.readSnapshot = async () => { throw new WebOsError('CONNECTION_LOST', 'synthetic standby socket loss'); };
      await h.service.status(); await drain();
      expect(h.service.powerState().observedPower).toBe('standby');
      h.observe('on');
      await h.service.status(); await drain();
      expect((await h.service.status()).connection).toBe('available');
      expect(h.service.remoteState().enabled).toBe(true);
      expect(h.service.powerState().operation).toMatchObject({ action: 'recover', status: 'succeeded' });
      expect(h.powerAdapters.reduce((n, adapter) => n + adapter.pairs, 0)).toBe(2);
      expect(await h.powerAdapters.at(-1)!.enteredPair.promise).toMatchObject({ credential: 'synthetic-key' });
      expect(h.requests).toHaveLength(1);
    } finally { await h.service.close(); await h.base.service.close(); }
  });
  test('Samsung startup standby physical wake reconnects without any power request', async () => {
    const h = await samsung('standby');
    try {
      h.observe('on'); await h.service.status(); await drain();
      expect((await h.service.status()).connection).toBe('available');
      expect(h.service.remoteState().enabled).toBe(true);
      expect(h.requests).toEqual([]);
      expect(h.powerAdapters.reduce((n, adapter) => n + adapter.pairs, 0)).toBe(1);
    } finally { await h.service.close(); await h.base.service.close(); }
  });
  test('Samsung physical wake rechecks on before pairing and never wakes a TV returned to standby', async () => {
    const h = await samsung('standby');
    try {
      let reads = 0;
      h.read(async () => ++reads === 1 ? 'on' : 'standby');
      await h.service.status(); await drain();
      expect(h.powerAdapters.every(adapter => adapter.pairs === 0)).toBe(true);
      h.scheduler.advance(1_000); await drain();
      await h.service.status(); await drain();
      expect(h.service.powerState().operation).toMatchObject({ action: 'recover', status: 'failed' });
      expect(h.requests).toEqual([]);
      expect(h.powerAdapters.every(adapter => adapter.pairs === 0)).toBe(true);
    } finally { await h.service.close(); await h.base.service.close(); }
  });
  test('Samsung transient snapshot failure recovers only after fresh HTTP on', async () => {
    const h = await samsung();
    try {
      h.service.start({ action: 'reconnect' }); await drain();
      h.powerAdapters.at(-1)!.readSnapshot = async () => { throw new WebOsError('CONNECTION_LOST', 'synthetic snapshot loss'); };
      expect((await h.service.status()).error?.code).toBe('CONNECTION_LOST'); await drain();
      expect(h.powerAdapters.reduce((count, adapter) => count + adapter.pairs, 0)).toBe(2);
      expect(h.service.powerState().operation).toMatchObject({ action: 'recover', status: 'succeeded' });
    } finally { await h.service.close(); await h.base.service.close(); }
  });
  test.each(['standby', 'unknown'] as const)('Samsung recovery never pairs when fresh guard changes on to %s', async state => {
    const h = await samsung('on', { recoveryTimeoutMs: 5_000 });
    try {
      h.service.start({ action: 'reconnect' }); await drain();
      h.powerAdapters.at(-1)!.readSnapshot = async () => { throw new WebOsError('CONNECTION_LOST', 'synthetic snapshot loss'); };
      let reads = 0;
      h.read(async () => ++reads === 1 ? 'on' : state);
      await h.service.status(); await drain();
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(h.powerAdapters.reduce((count, adapter) => count + adapter.pairs, 0)).toBe(1);
      expect((await h.service.status()).error?.code).toBe('CONNECTION_LOST');
    } finally { await h.service.close(); await h.base.service.close(); }
  });
  test('Samsung recovery rechecks HTTP before retrying a failed handshake', async () => {
    const h = await samsung('on', { recoveryTimeoutMs: 5_000 });
    try {
      h.service.start({ action: 'reconnect' }); await drain();
      h.powerAdapters.at(-1)!.readSnapshot = async () => { throw new WebOsError('CONNECTION_LOST', 'synthetic snapshot loss'); };
      let reads = 0;
      h.read(async () => {
        reads++;
        if (reads === 2) {
          h.powerAdapters.at(-1)!.pair = async () => { h.powerAdapters.at(-1)!.pairs++; throw new WebOsError('NETWORK_UNREACHABLE', 'synthetic handshake failure'); };
        }
        return reads <= 2 ? 'on' : 'standby';
      });
      await h.service.status(); await drain();
      expect(h.powerAdapters.reduce((count, adapter) => count + adapter.pairs, 0)).toBe(2);
      h.scheduler.advance(1_000); await drain();
      expect(reads).toBe(3);
      expect(h.powerAdapters.reduce((count, adapter) => count + adapter.pairs, 0)).toBe(2);
    } finally { await h.service.close(); await h.base.service.close(); }
  });
  test.each(['standby', 'unknown'] as const)('Samsung temporary HTTP %s observation retains snapshot cause and never pairs', async state => {
    const h = await samsung();
    try {
      h.service.start({ action: 'reconnect' }); await drain();
      h.powerAdapters.at(-1)!.readSnapshot = async () => { throw new WebOsError('CONNECTION_LOST', 'synthetic snapshot loss'); };
      h.observe('standby');
      await h.service.status(); await drain();
      h.observe(state);
      expect((await h.service.status()).error?.code).toBe('CONNECTION_LOST'); await drain();
      expect(h.powerAdapters.reduce((count, adapter) => count + adapter.pairs, 0)).toBe(1);
      expect(h.service.powerState().operation).toBeNull();
    } finally { await h.service.close(); await h.base.service.close(); }
  });
  test('Samsung close owns a pending recovery HTTP guard and rejects its late on before pairing', async () => {
    const h = await samsung(); const reading = barrier<'on'>();
    h.service.start({ action: 'reconnect' }); await drain();
    h.powerAdapters.at(-1)!.readSnapshot = async () => { throw new WebOsError('CONNECTION_LOST', 'synthetic snapshot loss'); };
    let reads = 0;
    h.read(async () => ++reads === 1 ? 'on' : reading.promise);
    await h.service.status(); await drain();
    let closed = false; const closing = h.service.close().then(() => { closed = true; }); await drain();
    expect(closed).toBe(false);
    reading.resolve('on'); await closing;
    expect(h.powerAdapters.reduce((count, adapter) => count + adapter.pairs, 0)).toBe(1);
    expect(h.powerAdapters.every(adapter => adapter.closed)).toBe(true);
    await h.base.service.close();
  });
  test('Samsung failed fresh recovery HTTP guard clears observed on without pairing', async () => {
    const h = await samsung();
    try {
      h.service.start({ action: 'reconnect' }); await drain();
      h.powerAdapters.at(-1)!.readSnapshot = async () => { throw new WebOsError('CONNECTION_LOST', 'synthetic snapshot loss'); };
      let reads = 0;
      h.read(async () => {
        if (++reads === 1) return 'on';
        throw new WebOsError('NETWORK_UNREACHABLE', 'synthetic HTTP failure');
      });
      await h.service.status(); await drain();
      expect(h.service.powerState().observedPower).toBe('unknown');
      expect((await h.service.status()).error?.code).toBe('NETWORK_UNREACHABLE');
      expect(h.powerAdapters.reduce((count, adapter) => count + adapter.pairs, 0)).toBe(1);
    } finally { await h.service.close(); await h.base.service.close(); }
  });
  test('Samsung recovery HTTP guard timeout invalidates on before its late result settles', async () => {
    const h = await samsung(); const reading = barrier<'on'>();
    try {
      h.service.start({ action: 'reconnect' }); await drain();
      h.powerAdapters.at(-1)!.readSnapshot = async () => { throw new WebOsError('CONNECTION_LOST', 'synthetic snapshot loss'); };
      let reads = 0;
      h.read(async () => ++reads === 1 ? 'on' : reading.promise);
      await h.service.status(); await drain();
      h.scheduler.advance(1_000); await drain();
      expect(h.service.powerState().observedPower).toBe('unknown');
      reading.resolve('on'); await drain();
      expect(h.service.powerState()).toMatchObject({ observedPower: 'unknown', operation: { status: 'failed', error: { code: 'RECOVERY_TIMEOUT' } } });
      expect(h.powerAdapters.reduce((count, adapter) => count + adapter.pairs, 0)).toBe(1);
    } finally { reading.resolve('on'); await h.service.close(); await h.base.service.close(); }
  });
  test('Samsung reconnect retains verified WSS and reports unknown HTTP power at completion', async () => {
    let completed: TvStatusResponse | undefined;
    const h = await samsung('on', { onOperationFinished() {
      void h.service.status().then(status => { completed = status; });
    } });
    h.observe('unknown');
    h.service.start({ action: 'reconnect' }); await drain();
    expect(completed).toMatchObject({ connection: 'available', error: { code: 'INVALID_TV_RESPONSE' } });
    expect(h.service.powerState()).toMatchObject({ observedPower: 'unknown', canWake: false, canPowerOff: false });
    expect(h.powerAdapters.at(-1)!.closed).toBe(false);
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung cleanup failure retains the shared admission gate', async () => {
    const h = await samsung();
    h.set(async () => {
      h.powerAdapters.at(-1)!.disconnectResult = Promise.reject(new Error('synthetic cleanup'));
      throw new TvPowerSendError('CONNECTION_LOST', 'not_sent', 'synthetic send');
    });
    h.service.startPower(off, 'owner'); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', error: { code: 'CONNECTION_LOST_CLEANUP_FAILED' } });
    expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'CLEANUP_FAILED' }));
    await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    await h.base.service.close();
  });
  test('Samsung HTTP probe gates mutation and late close observation cannot publish', async () => {
    const h = await samsung(); const reading = barrier<'on' | 'standby' | 'unknown'>();
    h.read(() => reading.promise);
    const probe = h.service.status(); await drain();
    expect(() => h.service.startPower(off, 'owner')).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    const closing = h.service.close(); await drain();
    expect(h.service.powerState().busy).toBe(true);
    reading.resolve('standby'); await probe; await closing;
    expect(h.service.powerState()).toMatchObject({ observedPower: 'on', canWake: false });
    await h.base.service.close();
  });
  test('Samsung wake remains available when HTTP confirms standby and WSS stays usable', async () => {
    const h = await samsung(); h.service.start({ action: 'reconnect' }); await drain();
    h.service.startPower(off, 'owner'); await drain();
    expect((await h.service.status()).connection).toBe('available');
    expect(h.service.powerState()).toMatchObject({ observedPower: 'standby', canWake: true, operation: { status: 'succeeded' } });
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung HTTP failure after unknown send cannot prove standby', async () => {
    const h = await samsung(); h.fail(new TvPowerSendError('CONNECTION_LOST', 'unknown', 'synthetic send'));
    h.read(async () => { throw new WebOsError('NETWORK_UNREACHABLE', 'synthetic HTTP failure'); });
    h.service.startPower(off, 'owner'); await drain();
    for (let index = 0; index < 5; index++) { h.scheduler.advance(1_000); await drain(); }
    expect(h.service.powerState()).toMatchObject({ observedPower: 'unknown', operation: { status: 'failed', delivery: 'unknown', error: { code: 'POWER_OFF_UNCONFIRMED' } } });
    expect(h.requests).toHaveLength(1);
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung startup standby observes without pairing or automatic recovery', async () => {
    const h = await samsung('standby');
    await h.service.initialize(); await drain();
    expect(h.requests).toHaveLength(0);
    expect(h.powerAdapters.every(adapter => adapter.pairs === 0)).toBe(true);
    expect(h.service.powerState()).toMatchObject({ observedPower: 'standby', canWake: true, operation: null });
    expect((await h.service.status()).connection).toBe('unavailable');
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung cancellation during encryption prevents late repository replacement', async () => {
    const cipher = harness().cipher;
    const encrypting = barrier<ReturnType<typeof cipher.encrypt>>();
    const h = await samsung('on', { cipher: { decrypt: cipher.decrypt, encrypt: () => encrypting.promise } });
    h.set(async (_desired, request) => {
      await request.onPaired?.({ ...pairing, credential: 'synthetic-rotated' });
      return { delivery: 'sent' };
    });
    h.service.startPower(off, 'owner'); await drain();
    await h.service.cancelOwnedPower('owner');
    encrypting.resolve(cipher.encrypt('synthetic-rotated')); await drain();
    expect(h.base.writes).toHaveLength(1);
    expect(h.service.powerState().operation).toMatchObject({ status: 'cancelled' });
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung storage failure prevents a clean usable session and any toggle', async () => {
    const h = await samsung(); let toggles = 0;
    h.base.repository.replace = () => { throw new Error('synthetic storage failure'); };
    h.set(async (_desired, request) => {
      try { await request.onPaired?.({ ...pairing, credential: 'synthetic-rotated' }); }
      catch (cause) { throw new TvPowerSendError('UNKNOWN', 'not_sent', 'synthetic storage', { cause }); }
      toggles++; return { delivery: 'sent' };
    });
    h.service.startPower(off, 'owner'); await drain();
    expect(toggles).toBe(0);
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'not_sent', error: { code: 'STORAGE_FAILED' } });
    expect((await h.service.status()).connection).toBe('unavailable');
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung rotated credential persists before send even when transport then fails', async () => {
    const h = await samsung();
    h.set(async (_desired, request) => {
      await request.onPaired?.({ ...pairing, credential: 'synthetic-rotated' });
      expect(h.cipher.decrypt(h.base.repository.load()!.encryptedCredential)).toBe('synthetic-rotated');
      throw new TvPowerSendError('CONNECTION_LOST', 'not_sent', 'synthetic transport');
    });
    h.service.startPower(off, 'owner'); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'not_sent', error: { code: 'CONNECTION_LOST' } });
    h.service.start({ action: 'reconnect' }); await drain();
    expect(await h.powerAdapters.at(-1)!.enteredPair.promise).toMatchObject({ credential: 'synthetic-rotated' });
    expect(h.cipher.decrypt(h.base.repository.load()!.encryptedCredential)).toBe('synthetic-key');
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung cancellation retains send ownership and rejects late persistence', async () => {
    const h = await samsung(); const handshake = barrier<void>();
    h.set(async (_desired, request) => {
      await handshake.promise;
      await request.onPaired?.({ ...pairing, credential: 'synthetic-late' });
      return { delivery: 'sent' };
    });
    h.service.startPower(off, 'owner'); await drain();
    const cancelled = h.service.cancelOwnedPower('owner'); await drain();
    expect(h.service.powerState()).toMatchObject({ busy: true, operation: { status: 'cancelled' } });
    handshake.resolve(); await cancelled;
    expect(h.service.powerState().operation).toMatchObject({ status: 'cancelled', delivery: 'unknown' });
    expect(h.cipher.decrypt(h.base.repository.load()!.encryptedCredential)).toBe('synthetic-key');
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung unknown delivery expiry preserves receipt and never retransmits', async () => {
    const h = await samsung(); h.fail(new TvPowerSendError('CONNECTION_LOST', 'unknown', 'synthetic transport'));
    h.service.startPower(off, 'owner'); await drain();
    for (let index = 0; index < 5; index++) { h.scheduler.advance(1_000); await drain(); }
    expect(h.requests).toHaveLength(1);
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'unknown', error: { code: 'POWER_OFF_UNCONFIRMED' } });
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung wake without MAC confirms on and reconnects without WOL', async () => {
    const h = await samsung('standby');
    h.service.start({ action: 'reconnect' }); await drain();
    expect((await h.service.status()).connection).toBe('available');
    expect(h.service.powerState()).toMatchObject({ canWake: true, wakeSupported: true, mac: null });
    h.service.startPower(wake, 'owner'); await drain();
    expect(h.service.powerState()).toMatchObject({ observedPower: 'on', operation: { action: 'wake', status: 'succeeded', delivery: 'sent' } });
    expect(h.requests).toHaveLength(1);
    expect((await h.service.status()).connection).toBe('available');
    expect(h.service.remoteState().enabled).toBe(true);
    expect(h.powerAdapters.flatMap(adapter => adapter.wakes)).toEqual([]);
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung wake from a disconnected standby reconnects with the saved credential', async () => {
    const h = await samsung('standby');
    expect((await h.service.status()).connection).toBe('unavailable');
    h.service.startPower(wake, 'owner'); await drain();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ credential: 'synthetic-key' });
    expect(h.service.powerState()).toMatchObject({ observedPower: 'on', canPowerOff: true, canWake: false, operation: { status: 'succeeded' } });
    expect(h.service.remoteState().enabled).toBe(true);
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung wake unknown delivery only observes on and never retransmits', async () => {
    const h = await samsung('standby');
    h.set(async () => { h.observe('on'); throw new TvPowerSendError('CONNECTION_LOST', 'unknown', 'synthetic delivery'); });
    h.service.startPower(wake, 'owner'); await drain();
    expect(h.requests).toHaveLength(1);
    expect(h.service.powerState().operation).toMatchObject({ status: 'succeeded', delivery: 'unknown' });
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung wake unknown delivery expires without pairing or retransmission while still standby', async () => {
    const h = await samsung('standby');
    h.fail(new TvPowerSendError('CONNECTION_LOST', 'unknown', 'synthetic delivery'));
    h.service.startPower(wake, 'owner'); await drain();
    h.scheduler.advance(1_000); await drain();
    expect(h.requests).toHaveLength(1);
    expect(h.powerAdapters.every(adapter => adapter.pairs === 0)).toBe(true);
    expect(h.service.powerState()).toMatchObject({ observedPower: 'standby', operation: { status: 'failed', delivery: 'unknown', error: { code: 'RECOVERY_TIMEOUT' } } });
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung already-desired live guard succeeds without send after cached on state', async () => {
    const h = await samsung(); h.observe('standby'); h.noSend();
    h.service.startPower(off, 'owner'); await drain();
    expect(h.service.powerState()).toMatchObject({ observedPower: 'standby', operation: { status: 'succeeded', delivery: 'not_sent' } });
    await h.service.close(); await h.base.service.close();
  });
  test('Samsung unknown delivery observes without retransmission and preserves delivery', async () => {
    const h = await samsung(); h.observe('standby');
    h.fail(new TvPowerSendError('CONNECTION_LOST', 'unknown', 'synthetic delivery'));
    h.service.startPower(off, 'owner'); await drain();
    expect(h.requests).toHaveLength(1);
    expect(h.service.powerState().operation).toMatchObject({ status: 'succeeded', delivery: 'unknown' });
    await h.service.close(); await h.base.service.close();
  });
  test.each(['on', 'standby', 'unknown'] as const)('Samsung HTTP observation controls admission independently of WSS: %s', async (observed) => {
    const base = harness(true); base.repository.replace({ ...base.repository.load()!, platform: 'tizen' });
    let pairs = 0;
    const h = harness(true, { repository: base.repository, createAdapter(_host, staging) {
      const adapter = new ControlledAdapter(staging);
      adapter.pair = async () => { pairs++; return pairing; };
      return Object.assign(adapter, { readPowerState: async () => observed });
    } });
    const status = await h.service.status();
    expect(h.service.powerState()).toMatchObject({ observedPower: observed, wakeSupported: true, canPowerOff: observed === 'on', canWake: observed === 'standby' });
    expect(pairs).toBe(0);
    if (observed === 'unknown') {
      expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'INVALID_TV_RESPONSE' }));
      expect(status.error?.code).toBe('INVALID_TV_RESPONSE');
      expect(() => h.service.startPower(off, 'owner')).toThrowError(expect.objectContaining({ code: 'INVALID_TV_RESPONSE' }));
    }
    await h.service.close(); await base.service.close();
  });
  test('offline Samsung cannot advertise or admit wake solely from a saved MAC', async () => {
    const base = harness(true); base.repository.replace({ ...base.repository.load()!, platform: 'tizen', macAddress: '02:00:00:00:00:02' });
    const h = harness(true, { repository: base.repository });
    try {
      expect(h.service.powerState().canWake).toBe(false);
      expect(h.service.powerState()).toMatchObject({ wakeSupported: true, observedPower: 'unknown' });
      expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'INVALID_TV_RESPONSE' }));
      expect(h.adapters).toEqual([]);
      await h.service.initialize(); await drain();
      expect(h.service.powerState().canWake).toBe(false);
      expect(h.adapters.flatMap(adapter => adapter.wakes)).toEqual([]);
    } finally { await h.service.close(); await base.service.close(); }
  });
  test('LG wake support is distinct from a missing saved MAC', async () => {
    const h = harness(true);
    try { expect(h.service.powerState()).toMatchObject({ wakeSupported: true, canWake: false, mac: null }); }
    finally { await h.service.close(); }
  });
  test.each(['sent timeout', 'unknown delivery', 'send failure'] as const)('manual reconnect supersedes only the connection timeout: %s', async (scenario) => {
    const base = harness(true); base.repository.replace({ ...base.repository.load()!, macAddress: '02:00:00:00:00:01' });
    const adapters: ControlledAdapter[] = [];
    const h = harness(true, { repository: base.repository, recoveryTimeoutMs: 1_000, createAdapter(_host, staging) {
      const adapter = new ControlledAdapter(staging);
      if (!adapters.length && scenario !== 'sent timeout') adapter.wakeResult = Promise.reject(new TvPowerSendError('NETWORK_UNREACHABLE', scenario === 'unknown delivery' ? 'unknown' : 'not_sent', 'synthetic send failure'));
      adapters.push(adapter); return adapter;
    } });
    const receipts: unknown[] = []; h.service.onPowerFinished((result) => receipts.push(result));
    h.service.startPower(wake, 'owner'); await drain();
    if (scenario === 'sent timeout') { h.scheduler.advance(1_000); await drain(); }
    expect(h.service.powerState().operation?.status).toBe('failed');
    h.service.start({ action: 'reconnect' }); await drain(); await succeed(adapters.at(-1)!);
    expect((await h.service.status()).connection).toBe('available');
    if (scenario === 'sent timeout') expect(h.service.powerState().operation).toBeNull();
    else expect(h.service.powerState().operation).toMatchObject({ status: 'failed', error: { code: 'NETWORK_UNREACHABLE' } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ id, status: 'failed' });
    await h.service.close(); await base.service.close();
  });
  test('wake replaces automatic recovery and ignores its late successful pairing', async () => {
    const h = await connected(); h.service.setMac('02:00:00:00:00:01');
    h.adapters[0]!.readResult = barrier();
    const reading = h.service.status(); await drain();
    h.adapters[0]!.readResult.reject(new WebOsError('CONNECTION_LOST', 'synthetic offline'));
    await reading; await drain();
    const old = h.adapters[1]!; const cleanup = barrier<void>(); old.disconnectResult = cleanup.promise;
    expect(h.service.powerState()).toMatchObject({ canWake: true, operation: { action: 'recover', status: 'running' } });
    h.service.startPower(wake, 'owner'); await drain();
    old.pairResult.resolve(pairing); await drain();
    expect(h.adapters).toHaveLength(2);
    expect(h.service.powerState().operation).toMatchObject({ action: 'wake', delivery: 'not_sent', status: 'running' });
    cleanup.resolve(); await drain();
    expect(h.adapters[2]!.wakes).toEqual([['02:00:00:00:00:01']]);
    await succeed(h.adapters[3]!);
    expect(h.service.powerState().operation).toMatchObject({ action: 'wake', status: 'succeeded', delivery: 'sent' });
    await h.service.close();
  });
  test.each(['cleanup failure', 'wake deadline'] as const)('replacement sends no WOL after %s', async (failure) => {
    const h = harness(true, { recoveryTimeoutMs: 1_000 });
    h.service.setMac('02:00:00:00:00:01'); await h.service.initialize(); await drain();
    const cleanup = barrier<void>(); h.adapters[0]!.disconnectResult = cleanup.promise;
    h.service.startPower(wake, 'owner'); await drain();
    if (failure === 'wake deadline') {
      h.scheduler.advance(1_000); await drain();
      expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'not_sent' });
      expect(h.service.powerState().busy).toBe(true);
      expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
      cleanup.resolve();
    }
    else cleanup.reject(new Error('synthetic cleanup failure'));
    await drain();
    expect(h.adapters).toHaveLength(1);
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'not_sent', error: { code: failure === 'wake deadline' ? 'RECOVERY_TIMEOUT' : 'CLEANUP_FAILED' } });
    if (failure === 'cleanup failure') await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    else await h.service.close();
  });
  test('wake cannot replace explicit repair even with a saved MAC', async () => {
    const h = harness(true); h.service.setMac('02:00:00:00:00:01');
    h.service.start({ action: 'repair' }); await drain();
    expect(h.service.powerState().canWake).toBe(false);
    expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    await h.service.close();
  });
  test('wake supersedes reconnect but waits for its transport cleanup before sending', async () => {
    const h = harness(true);
    h.service.setMac('02:00:00:00:00:01');
    await h.service.initialize(); await drain();
    const old = h.adapters[0]!;
    const cleanup = barrier<void>(); old.disconnectResult = cleanup.promise;
    expect(h.service.powerState().canWake).toBe(true);
    h.service.startPower(wake, 'owner'); await drain();
    expect((await old.enteredPair.promise).signal.aborted).toBe(true);
    expect(h.adapters).toHaveLength(1);
    expect(h.service.powerState().operation).toMatchObject({ action: 'wake', status: 'running', delivery: 'not_sent' });
    expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    cleanup.resolve(); await drain();
    expect(h.adapters[1]!.wakes).toEqual([['02:00:00:00:00:01']]);
    await succeed(h.adapters[2]!);
    expect(h.service.powerState().operation).toMatchObject({ status: 'succeeded', delivery: 'sent' });
    await h.service.close();
  });
  test('power off returns a strict public operation without its request confirmation', async () => {
    const h = await connected();
    try {
      const operation = h.service.startPower(off, 'owner');
      expect(tvPowerOperationSchema.safeParse(operation).success).toBe(true);
      expect(tvPowerStateSchema.safeParse(h.service.powerState()).success).toBe(true);
    } finally { await h.service.close(); }
  });
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
    expect(h.adapters[0]!.closed).toBe(false); expect((await h.service.status()).connection).toBe('available');
    expect(h.service.remoteState()).toEqual({ enabled: true, reason: null, apps: true }); await h.service.close();
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

  test.each([
    ['AUTHORIZATION_FAILED', 'authorization_error'],
    ['INVALID_TV_RESPONSE', 'compatibility_error'],
  ] as const)('off observation %s is failure and never physical-off success', async (code, connection) => {
    const h = await connected(); h.service.setMac('02:00:00:00:00:01'); h.adapters[0]!.readResult = barrier(); h.service.startPower(off, 'owner'); await drain();
    h.adapters[0]!.readResult.reject(new WebOsError(code, 'synthetic')); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'sent', error: { code } });
    expect((await h.service.status()).connection).toBe(connection); expect(h.service.powerState().canWake).toBe(false);
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
    const h = harness(true); const key = h.repository.load()!.encryptedCredential;
    expect(h.service.setMac('02-ab-cd-ef-00-01')).toMatchObject({ mac: '02:AB:CD:EF:00:01', canWake: true });
    expect(h.repository.load()!.encryptedCredential).toEqual(key);
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

  test('unconfirmed off disposes the connection and admits explicit wake only after cleanup settles', async () => {
    const h = await connected(); h.service.setMac('02:00:00:00:00:01'); const adapter = h.adapters[0]!;
    const cleanup = barrier<void>(); adapter.disconnectResult = cleanup.promise;
    try {
      h.service.startPower(off, 'owner'); await drain(); expect(adapter.reads).toBe(2);
      h.scheduler.advance(999); await drain(); expect(adapter.reads).toBe(2);
      h.scheduler.advance(1); await drain(); expect(adapter.reads).toBe(3);
      h.scheduler.advance(4_000); await drain();
      expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'sent', phase: 'finished', error: { code: 'POWER_OFF_UNCONFIRMED' } });
      expect((await h.service.status()).connection).toBe('unavailable');
      expect(adapter.closed).toBe(true); expect(h.service.powerState()).toMatchObject({ canPowerOff: false, canWake: false });
      expect(h.service.remoteState()).toEqual({ enabled: false, reason: 'BUSY' });
      expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
      cleanup.resolve(); await drain();
      expect(h.service.powerState()).toMatchObject({ canPowerOff: false, canWake: true, operation: { status: 'failed', delivery: 'sent', error: { code: 'POWER_OFF_UNCONFIRMED' } } });
      expect(h.service.remoteState()).toEqual({ enabled: false, reason: 'UNAVAILABLE' });
      h.scheduler.advance(60_000);
      for (let poll = 0; poll < 3; poll++) expect((await h.service.status()).connection).toBe('unavailable');
      await drain(); expect(h.adapters).toHaveLength(1); expect(adapter.powerOffs).toBe(1); expect(adapter.wakes).toEqual([]); expect(adapter.reads).toBe(3);
      h.service.startPower(wake, 'owner');
      expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
      await drain(); expect(h.adapters[1]!.wakes).toEqual([['02:00:00:00:00:01']]);
      await succeed(h.adapters[2]!);
      expect(h.service.powerState().operation).toMatchObject({ action: 'wake', status: 'succeeded', delivery: 'sent' });
      expect((await h.service.status()).connection).toBe('available');
    } finally { cleanup.resolve(); await h.service.close(); }
  });

  test('unconfirmed off cleanup failure disables wake and retains the unconfirmed result', async () => {
    const h = await connected(); h.service.setMac('02:00:00:00:00:01'); const adapter = h.adapters[0]!;
    const cleanup = barrier<void>(); adapter.disconnectResult = cleanup.promise;
    try {
      h.service.startPower(off, 'owner'); await drain(); h.scheduler.advance(5_000); await drain();
      cleanup.reject(new Error('synthetic cleanup failure')); await drain();
      expect((await h.service.status()).connection).toBe('unavailable');
      expect(h.service.powerState()).toMatchObject({ canPowerOff: false, canWake: false, operation: { status: 'failed', delivery: 'sent', error: { code: 'POWER_OFF_UNCONFIRMED_CLEANUP_FAILED' } } });
      expect(h.service.remoteState()).toEqual({ enabled: false, reason: 'UNAVAILABLE' });
      expect(() => h.service.startPower(wake, 'owner')).toThrowError(expect.objectContaining({ code: 'CLEANUP_FAILED' }));
      h.scheduler.advance(60_000); await h.service.status(); await drain(); expect(h.adapters).toHaveLength(1); expect(adapter.wakes).toEqual([]);
    } finally { cleanup.resolve(); await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' }); }
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
    const h = await connected(); h.service.setMac('02:00:00:00:00:01'); const adapter = h.adapters[0]!; const pending = barrier<void>(); adapter.powerResult = pending.promise;
    h.service.startPower(off, 'owner'); await drain(); h.scheduler.advance(5_000); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', delivery: 'unknown' });
    expect(() => h.service.setMac(null)).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    pending.resolve(); await drain(); expect(h.service.powerState().operation?.status).toBe('failed');
    expect((await h.service.status()).connection).toBe('unavailable');
    expect(h.service.powerState()).toMatchObject({ canWake: true, operation: { status: 'failed', delivery: 'unknown', error: { code: 'POWER_OFF_UNCONFIRMED' } } });
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
