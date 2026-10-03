import { describe, expect, test } from 'vitest';
import { WebOsError } from '@remote-webos-tv/webos';
import { barrier, drain, harness, pairing, snapshot, succeed } from './support/tv-harness.js';

describe('TV lifecycle barriers', () => {
  test('operation timeout is terminal while adapter cleanup remains pending and close waits', async () => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const cleanup = barrier<void>(); h.adapters[0]!.disconnectResult = cleanup.promise;
    h.scheduler.advance(60_000); await drain();
    try {
      expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'PAIRING_TIMEOUT' } });
      expect(() => h.service.start({ action: 'pair', host: '192.168.1.11' })).toThrowError(expect.objectContaining({ statusCode: 409 }));
      let closed = false; const closing = h.service.close().then(() => { closed = true; }); await drain();
      expect(closed).toBe(false); cleanup.resolve(); await closing;
    } finally { cleanup.resolve(); await h.service.close(); }
  });

  test('replacement timeout publishes even while disconnecting the previous adapter', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!);
    const cleanup = barrier<void>(); h.adapters[0]!.disconnectResult = cleanup.promise;
    h.service.start({ action: 'repair' }); await drain(); h.scheduler.advance(60_000); await drain();
    try {
      expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'PAIRING_TIMEOUT' } });
      expect(h.adapters).toHaveLength(1); expect(h.writes).toEqual([]);
      expect(() => h.service.start({ action: 'reconnect' })).toThrowError(expect.objectContaining({ statusCode: 409 }));
    } finally { cleanup.resolve(); await h.service.close(); }
  });

  test('status timeout publishes unavailable before pending cleanup finishes', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!);
    const adapter = h.adapters[0]!; adapter.readResult = barrier(); const cleanup = barrier<void>(); adapter.disconnectResult = cleanup.promise;
    let response: Awaited<ReturnType<typeof h.service.status>> | undefined;
    const reading = h.service.status().then((status) => { response = status; }); await drain(); h.scheduler.advance(5_000); await drain();
    try {
      expect(response?.connection).toBe('unavailable');
      expect(() => h.service.start({ action: 'repair' })).toThrowError(expect.objectContaining({ statusCode: 409 }));
      let closed = false; const closing = h.service.close().then(() => { closed = true; }); await drain(); expect(closed).toBe(false);
      cleanup.resolve(); await Promise.all([reading, closing]);
    } finally { cleanup.resolve(); await reading; await h.service.close(); }
  });

  test('known status failure publishes immediately and late cleanup failure safely enriches it', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!);
    const adapter = h.adapters[0]!; adapter.readResult = barrier(); const cleanup = barrier<void>(); adapter.disconnectResult = cleanup.promise;
    let response: Awaited<ReturnType<typeof h.service.status>> | undefined;
    const reading = h.service.status().then((status) => { response = status; }); await drain();
    adapter.readResult.reject(new WebOsError('AUTHORIZATION_FAILED', 'private')); await drain();
    try {
      expect(response?.connection).toBe('authorization_error'); expect(response?.error?.code).toBe('AUTHORIZATION_FAILED');
      cleanup.reject(new Error('private cleanup')); await drain();
      expect((await h.service.status()).error?.code).toBe('AUTHORIZATION_FAILED_CLEANUP_FAILED');
      await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    } finally { cleanup.resolve(); await reading; await h.service.close().catch(() => {}); }
  });
  test('cancel aborts registration, waits for cleanup before reuse and ignores late resolution', async () => {
    const h = harness(); const op = h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!; const request = await adapter.enteredPair.promise;
    const cleanup = barrier<void>(); adapter.disconnectResult = cleanup.promise;
    expect(h.service.cancel(op.id).status).toBe('cancelled'); expect(request.signal.aborted).toBe(true);
    await drain(); expect(() => h.service.start({ action: 'pair', host: '192.168.1.11' })).toThrowError(expect.objectContaining({ statusCode: 409 }));
    cleanup.resolve(); await drain();
    const next = h.service.start({ action: 'pair', host: '192.168.1.11' }); await drain();
    adapter.pairResult.resolve(pairing); await drain();
    expect(h.writes).toEqual([]);
    expect(() => h.service.cancel(op.id)).toThrowError(expect.objectContaining({ statusCode: 404 }));
    expect((await h.service.status()).operation?.id).toBe(next.id); await h.service.close();
  });

  test('monotonic timeout wins against late resolution even after wall clock rollback', async () => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!; h.setEpoch(1); h.scheduler.advance(60_000);
    adapter.pairResult.resolve(pairing); await drain();
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'PAIRING_TIMEOUT' }, deadlineAt: 1_060_000 });
    expect((await adapter.enteredPair.promise).signal.aborted).toBe(true); expect(h.writes).toEqual([]); await h.service.close();
  });

  test('cancel during async encryption prevents commit and late reject cannot affect next operation', async () => {
    const encryption = barrier<ReturnType<ReturnType<typeof harness>['cipher']['encrypt']>>();
    const base = harness(); const h = harness(false, { cipher: { ...base.cipher, encrypt: () => encryption.promise } });
    const op = h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
    expect(h.service.cancel(op.id).status).toBe('cancelled'); await drain();
    h.service.start({ action: 'pair', host: '192.168.1.11' }); await drain();
    encryption.reject(new Error('late private failure')); await drain(); expect(h.writes).toEqual([]);
    expect((await h.service.status()).operation).toMatchObject({ id: 'operation-2', status: 'running' }); await h.service.close(); await base.service.close();
  });

  test('close aborts pending work, ignores late snapshot and is idempotent', async () => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!; adapter.pairResult.resolve(pairing); await adapter.enteredRead.promise;
    const cleanup = barrier<void>(); adapter.disconnectResult = cleanup.promise;
    const closing = h.service.close(); const again = h.service.close(); await drain();
    adapter.readResult.resolve(snapshot); await drain(); expect(h.writes).toEqual([]);
    cleanup.resolve(); await Promise.all([closing, again]);
    expect(() => h.service.start({ action: 'pair', host: '192.168.1.10' })).toThrowError(expect.objectContaining({ code: 'SERVICE_CLOSED' }));
  });

  test('initialize returns promptly and starts exactly one saved-key reconnect', async () => {
    const h = harness(true); await h.service.initialize(); await h.service.initialize(); await drain();
    expect(h.adapters).toHaveLength(1); expect(h.policies[0]).toMatchObject({ prompt: false });
    expect(await h.adapters[0]!.staging.load()).toBe('synthetic-key');
    h.adapters[0]!.pairResult.reject(new WebOsError('NETWORK_UNREACHABLE', 'off')); await drain();
    expect((await h.service.status()).tv?.host).toBe('192.168.1.10'); expect(h.writes).toEqual([]); await h.service.close();
  });

  test('repair starts with no key and failed address change rolls back saved configuration', async () => {
    const h = harness(true); const original = h.repository.load();
    h.service.start({ action: 'repair' }); await drain();
    expect(await h.adapters[0]!.staging.load()).toBeUndefined(); expect(h.policies[0]?.prompt).toBe(true);
    h.adapters[0]!.pairResult.reject(new WebOsError('PAIRING_REJECTED', 'denied')); await drain();
    h.service.start({ action: 'change_address', host: '192.168.1.11' }); await drain();
    const replacement = h.adapters[1]!;
    expect(await replacement.staging.load()).toBe('synthetic-key'); expect(h.policies[1]?.prompt).toBe(false);
    replacement.pairResult.reject(new WebOsError('AUTHORIZATION_FAILED', 'revoked')); await drain();
    expect(h.repository.load()).toEqual(original); expect(replacement.closed).toBe(true);
    expect((await h.service.status()).connection).toBe('authorization_error'); expect(h.adapters).toHaveLength(2);
    h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[2]!);
    expect((await h.service.status()).connection).toBe('available'); expect(h.writes).toEqual([]); await h.service.close();
  });

  test('concurrent status reads share one bounded probe and its failure disconnects without writes', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!);
    const adapter = h.adapters[0]!; adapter.readResult = barrier();
    const first = h.service.status(); const second = h.service.status(); await drain();
    expect(adapter.reads).toBe(2); h.scheduler.advance(5_000); await drain();
    const statuses = await Promise.all([first, second]);
    expect(statuses.map((status) => status.connection)).toEqual(['unavailable', 'unavailable']);
    expect(adapter.closed).toBe(true); expect(h.writes).toEqual([]); expect(adapter.pairs).toBe(1);
    adapter.readResult.resolve(snapshot); await drain(); expect((await h.service.status()).connection).toBe('unavailable'); await h.service.close();
  });

  test('a replacement aborts an old status probe and late data cannot overwrite runtime state', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!);
    const old = h.adapters[0]!; old.readResult = barrier(); const reading = h.service.status(); await drain();
    h.service.start({ action: 'repair' }); await drain();
    expect(old.closed).toBe(true); old.readResult.resolve(snapshot); await reading;
    expect((await h.service.status()).connection).toBe('pairing'); await h.service.close();
  });

  test('cleanup failure preserves safe primary classification and blocks unsafe reuse', async () => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!; adapter.disconnectResult = Promise.reject(new Error('private cleanup detail'));
    adapter.pairResult.reject(new WebOsError('NETWORK_UNREACHABLE', 'private network detail')); await drain();
    expect((await h.service.status()).operation?.error?.code).toBe('NETWORK_UNREACHABLE_CLEANUP_FAILED');
    expect(() => h.service.start({ action: 'pair', host: '192.168.1.10' })).toThrowError(expect.objectContaining({ code: 'CLEANUP_FAILED' }));
    await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
  });

  test('known status cleanup gates repair until it finishes and cannot overwrite the next state', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!);
    const old = h.adapters[0]!; old.readResult = barrier();
    const cleanup = barrier<void>(); old.disconnectResult = cleanup.promise;
    const reading = h.service.status(); await drain();
    old.readResult.reject(new WebOsError('CONNECTION_LOST', 'private')); await drain();
    expect(() => h.service.start({ action: 'repair' })).toThrowError(expect.objectContaining({ statusCode: 409 }));
    cleanup.resolve(); await reading; await drain(); h.service.start({ action: 'repair' }); await drain();
    expect((await h.service.status()).connection).toBe('pairing');
    await h.service.close();
  });

  test('a status result at its monotonic deadline fails even before timer delivery', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!);
    const adapter = h.adapters[0]!; adapter.readResult = barrier();
    const reading = h.service.status(); await drain(); h.scheduler.time = 5_000;
    adapter.readResult.resolve(snapshot);
    expect((await reading).connection).toBe('unavailable'); expect(adapter.closed).toBe(true); await h.service.close();
  });

  test('reconnect commits rotated key only after snapshot and uses it for the next reconnect', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain();
    const adapter = h.adapters[0]!; adapter.pairResult.resolve({ ...pairing, clientKey: 'rotated-synthetic-key' });
    await adapter.enteredRead.promise; expect(h.cipher.decrypt(h.repository.load()!.encryptedClientKey)).toBe('synthetic-key');
    adapter.readResult.resolve(snapshot); await drain();
    expect(h.cipher.decrypt(h.repository.load()!.encryptedClientKey)).toBe('rotated-synthetic-key');
    h.service.start({ action: 'reconnect' }); await drain();
    expect((await h.adapters[1]!.enteredPair.promise).clientKey).toBe('rotated-synthetic-key');
    await h.service.close();
  });

  test('reconnect updates verified identity and rolls back a rotated key when snapshot fails', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain();
    const adapter = h.adapters[0]!; adapter.pairResult.resolve({ ...pairing, identity: { model: 'Synthetic Model', firmwareVersion: 'updated-version' } });
    await adapter.enteredRead.promise; adapter.readResult.resolve(snapshot); await drain();
    expect(h.repository.load()!.identity.firmwareVersion).toBe('updated-version');
    const saved = h.repository.load(); h.service.start({ action: 'reconnect' }); await drain();
    const second = h.adapters[1]!; second.pairResult.resolve({ ...pairing, clientKey: 'rotated-synthetic-key' });
    await second.enteredRead.promise; second.readResult.reject(new WebOsError('CONNECTION_LOST', 'private')); await drain();
    expect(h.repository.load()).toEqual(saved); expect(h.writes).toHaveLength(1); await h.service.close();
  });

  test('cancelling before the worker starts creates no adapter or permanent setting', async () => {
    const h = harness(); const operation = h.service.start({ action: 'pair', host: '192.168.1.10' });
    h.service.cancel(operation.id); await drain(); expect(h.adapters).toHaveLength(0); expect(h.repository.load()).toBeNull(); await h.service.close();
  });

  test('the final commit guard rejects expiry even before timer delivery', async () => {
    const base = harness(); const encryption = barrier<ReturnType<typeof base.cipher.encrypt>>();
    const h = harness(false, { cipher: { ...base.cipher, encrypt: () => encryption.promise } });
    h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
    h.scheduler.time = 60_000; encryption.resolve(base.cipher.encrypt('synthetic-key')); await drain();
    expect(h.writes).toEqual([]); expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'PAIRING_TIMEOUT' } });
    await h.service.close(); await base.service.close();
  });

  test('an accepted replacement never creates an adapter after its prior probe cleanup fails', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!);
    const old = h.adapters[0]!; old.readResult = barrier(); const cleanup = barrier<void>(); old.disconnectResult = cleanup.promise;
    const reading = h.service.status(); await drain();
    h.service.start({ action: 'repair' }); await drain(); cleanup.reject(new Error('private cleanup')); await reading; await drain();
    expect(h.adapters).toHaveLength(1); expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'CLEANUP_FAILED' } });
    await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
  });

  test('a terminal operation preserves its cause when current-generation cleanup later fails', async () => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!; const cleanup = barrier<void>(); adapter.disconnectResult = cleanup.promise;
    adapter.pairResult.reject(new WebOsError('NETWORK_UNREACHABLE', 'private primary')); await drain();
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'NETWORK_UNREACHABLE' } });
    cleanup.reject(new Error('private cleanup')); await drain();
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'NETWORK_UNREACHABLE_CLEANUP_FAILED' } });
    await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
  });

  test('replacement timeout retains its cause when previous adapter cleanup later fails', async () => {
    const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!);
    const cleanup = barrier<void>(); h.adapters[0]!.disconnectResult = cleanup.promise;
    h.service.start({ action: 'repair' }); await drain(); h.scheduler.advance(60_000); await drain();
    expect((await h.service.status()).operation?.error?.code).toBe('PAIRING_TIMEOUT');
    cleanup.reject(new Error('private cleanup')); await drain();
    expect((await h.service.status()).operation?.error?.code).toBe('PAIRING_TIMEOUT_CLEANUP_FAILED');
    await expect(h.service.close()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
  });
});
