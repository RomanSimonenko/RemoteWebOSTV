import { describe, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { Lgtv2Adapter, WebOsError, type Lgtv2Client } from '@remote-webos-tv/webos';
import { barrier, drain, harness, succeed } from './support/tv-harness.js';

describe('bounded TV recovery', () => {
  test('real pairing cleanup failure terminates recovery even when detached-client disconnect later succeeds', async () => {
    const adapters: Lgtv2Adapter[] = []; let disconnects = 0;
    const h = harness(true, { createAdapter(host, keyStore, requestTimeoutMs, allowPairingPrompt) {
      const adapter = new Lgtv2Adapter({ host, keyStore, requestTimeoutMs, handshakeTimeoutMs: requestTimeoutMs, allowPairingPrompt, now: () => new Date(0) }, {
        createClient() {
          const emitter = new EventEmitter();
          const client = Object.assign(emitter, {
            connected: false, urls: [], request: async () => { throw new Error('Unexpected SSAP request'); },
            send: () => { throw new Error('Unexpected hello request'); },
            getSocket: async () => { throw new Error('Unexpected pointer request'); }, wake: async () => undefined,
            disconnect: async () => { disconnects++; throw new Error('synthetic client cleanup failure'); },
          }) as Lgtv2Client;
          queueMicrotask(() => emitter.emit('error', Object.assign(new Error('synthetic connection failure'), { code: 'ECONNRESET' })));
          return client;
        },
      }); adapters.push(adapter); return adapter;
    } });
    h.service.start({ action: 'reconnect' }); await drain();
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'NETWORK_UNREACHABLE_CLEANUP_FAILED' } });
    await expect(adapters[0]!.disconnect()).resolves.toBeUndefined(); expect(disconnects).toBe(1);
    h.scheduler.advance(1_000); await drain(); expect(adapters).toHaveLength(1);
    expect(() => h.service.start({ action: 'reconnect' })).toThrowError(expect.objectContaining({ code: 'CLEANUP_FAILED' }));
    expect(() => h.service.setMac(null)).toThrowError(expect.objectContaining({ code: 'CLEANUP_FAILED' }));
    await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
  });
  test('recovery deadline retains the original transient cause on the owned attempt signal', async () => {
    const h = harness(true, { recoveryTimeoutMs: 2_000 }); h.service.start({ action: 'reconnect' }); await drain();
    const cause = new WebOsError('NETWORK_UNREACHABLE', 'synthetic root cause'); h.adapters[0]!.pairResult.reject(cause); await drain();
    h.scheduler.advance(1_000); await drain(); const request = await h.adapters[1]!.enteredPair.promise;
    h.scheduler.advance(1_000); await drain();
    expect(request.signal.reason).toMatchObject({ code: 'RECOVERY_TIMEOUT', cause });
    expect((await h.service.status()).operation?.error?.code).toBe('RECOVERY_TIMEOUT'); await h.service.close();
  });
  test('manual reconnect carries its opaque owner for session revocation without publishing it', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }, 'synthetic-private-owner'); await drain();
    await h.service.cancelOwnedPower('other'); expect((await h.service.status()).operation?.status).toBe('running');
    await h.service.cancelOwnedPower('synthetic-private-owner');
    expect((await h.service.status()).operation?.status).toBe('cancelled');
    expect(JSON.stringify(await h.service.status())).not.toContain('synthetic-private-owner');
    expect(h.adapters[0]!.closed).toBe(true); await h.service.close();
  });
  test('manual reconnect starts immediately and retries sequentially at 1, 2, 4 then 8 second cooldowns', async () => {
    const h = harness(true, { recoveryTimeoutMs: 30_000 }); h.service.start({ action: 'reconnect' }); await drain();
    expect(h.policies[0]).toMatchObject({ timeout: 5_000, prompt: false });
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      const count = h.adapters.length; h.adapters[count - 1]!.pairResult.reject(new WebOsError('NETWORK_UNREACHABLE', 'synthetic')); await drain();
      expect((await h.service.status()).operation?.status).toBe('running');
      h.scheduler.advance(delay - 1); await drain(); expect(h.adapters).toHaveLength(count);
      h.scheduler.advance(1); await drain(); expect(h.adapters).toHaveLength(count + 1);
    }
    await succeed(h.adapters.at(-1)!); expect((await h.service.status()).operation?.status).toBe('succeeded');
    expect(h.adapters.every((a) => a.sent.length === 0 && a.wakes.length === 0)).toBe(true); await h.service.close();
  });

  test('monotonic deadline includes attempts, caps last budget and is never extended by wall clock', async () => {
    const h = harness(true, { recoveryTimeoutMs: 7_000 }); const operation = h.service.start({ action: 'reconnect' }); await drain();
    expect(operation.deadlineAt).toBe(1_007_000);
    h.scheduler.advance(5_000); await drain(); expect(h.adapters[0]!.closed).toBe(true);
    h.scheduler.advance(1_000); await drain(); expect(h.policies[1]?.timeout).toBe(1_000);
    h.setEpoch(1); h.scheduler.advance(1_000); await drain();
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', deadlineAt: 1_007_000, error: { code: 'RECOVERY_TIMEOUT' } });
    h.scheduler.advance(300_000); await h.service.status(); await drain(); expect(h.adapters).toHaveLength(2); await h.service.close();
  });

  test.each(['AUTHORIZATION_FAILED', 'INVALID_TV_RESPONSE', 'UNSUPPORTED_CAPABILITY', 'KEY_STORE_CORRUPT'] as const)('%s terminates immediately without retry', async (code) => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain();
    h.adapters[0]!.pairResult.reject(new WebOsError(code, 'synthetic')); await drain();
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code } });
    h.scheduler.advance(60_000); await h.service.status(); await drain(); expect(h.adapters).toHaveLength(1); await h.service.close();
  });

  test('ordinary loss creates exactly one server-owned recovery; polling cannot restart exhaustion', async () => {
    const h = harness(true, { recoveryTimeoutMs: 1_000 }); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!);
    h.adapters[0]!.readResult = barrier(); const reading = h.service.status(); await drain();
    h.adapters[0]!.readResult.reject(new WebOsError('CONNECTION_LOST', 'synthetic')); await reading; await drain();
    expect(h.service.powerState().operation).toMatchObject({ action: 'recover', phase: 'connecting', delivery: 'not_sent', status: 'running' });
    expect(h.adapters).toHaveLength(2); await h.service.cancelOwnedPower('unrelated'); expect(h.service.powerState().operation?.status).toBe('running');
    h.scheduler.advance(1_000); await drain();
    expect(h.service.powerState().operation).toMatchObject({ status: 'failed', error: { code: 'RECOVERY_TIMEOUT' } });
    for (let poll = 0; poll < 3; poll++) await h.service.status(); h.scheduler.advance(60_000); await drain(); expect(h.adapters).toHaveLength(2); await h.service.close();
  });

  test('deadline publication does not free the gate during hung cleanup; shutdown waits', async () => {
    const h = harness(true, { recoveryTimeoutMs: 1_000 }); h.service.start({ action: 'reconnect' }); await drain();
    const cleanup = barrier<void>(); h.adapters[0]!.disconnectResult = cleanup.promise;
    h.scheduler.advance(1_000); await drain();
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'RECOVERY_TIMEOUT' } });
    expect(() => h.service.start({ action: 'repair' })).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    let closed = false; const closing = h.service.close().then(() => { closed = true; }); await drain(); expect(closed).toBe(false); cleanup.resolve(); await closing;
  });

  test('cleanup failure remains visible and forbids retry and fresh unsafe admission', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain();
    h.adapters[0]!.disconnectResult = Promise.reject(new Error('synthetic cleanup')); h.adapters[0]!.pairResult.reject(new WebOsError('NETWORK_UNREACHABLE', 'synthetic')); await drain();
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'NETWORK_UNREACHABLE_CLEANUP_FAILED' } });
    expect(() => h.service.start({ action: 'reconnect' })).toThrowError(expect.objectContaining({ code: 'CLEANUP_FAILED' }));
    await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
  });
});
