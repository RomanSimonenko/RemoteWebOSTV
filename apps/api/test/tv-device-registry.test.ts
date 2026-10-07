import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { createClientKeyCipher, WebOsError } from '@remote-webos-tv/webos';
import { schemaMigrations } from '../src/storage/migrations.js';
import { createTvDeviceRepository } from '../src/tv/repository.js';
import { createTvService } from '../src/tv/service.js';
import { TvServiceError } from '../src/tv/operation.js';
import { createTvDeviceRegistry } from '../src/tv/device-registry.js';
import { barrier, ControlledAdapter, ControlledScheduler, drain, succeed } from './support/tv-harness.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function setup() {
  const sqlite = new Database(':memory:'); for (const migration of schemaMigrations) migration.up(sqlite);
  const repository = createTvDeviceRepository(sqlite); const scheduler = new ControlledScheduler();
  const adapters: ControlledAdapter[] = []; let next = 0;
  const registry = createTvDeviceRegistry({ repository, scheduler,
    newId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
    createService: (repo, onOperationFinished) => createTvService({ repository: repo, onOperationFinished, scheduler, cipher: createClientKeyCipher(Buffer.alloc(32, 7)), now: () => scheduler.now(), newId: () => `operation-${++next}`, createAdapter(_host, staging) { const adapter = new ControlledAdapter(staging); adapters.push(adapter); return adapter; } }),
  });
  cleanups.push(async () => { await registry.close(); sqlite.close(); });
  return { registry, repository, scheduler, adapters };
}
const request = (id: number, host = '10.2.3.4') => ({ id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, platform: 'webos' as const, host });

test('isolatesTwoServices', async () => {
  const h = setup(); const first = h.registry.add(request(100), 'session'); await drain(); await succeed(h.adapters[0]!);
  const second = h.registry.add(request(101, '10.2.3.5'), 'session'); await drain(); await succeed(h.adapters[1]!);
  expect((await h.registry.list()).map((tv) => tv.tvId)).toEqual([first.tvId, second.tvId]);
  const signal = new AbortController().signal;
  await h.registry.get(first.tvId)!.sendCommand({ id: request(200).id, button: 'UP' }, signal);
  await h.registry.get(second.tvId)!.sendCommand({ id: request(200).id, button: 'DOWN' }, signal);
  expect(h.adapters[0]!.sent).toEqual(['UP']); expect(h.adapters[1]!.sent).toEqual(['DOWN']);
  expect(h.registry.legacy()).toBe(h.registry.get(first.tvId));
});

test('sameRequestDoesNotPairTwiceAndChangedRequestConflicts', async () => {
  const h = setup(); const accepted = h.registry.add(request(100), 'session');
  expect(h.registry.add(request(100), 'session')).toEqual(accepted);
  expect(() => h.registry.add(request(100, '10.2.3.5'), 'session')).toThrow(new TvServiceError('OPERATION_CONFLICT', 409));
  await drain(); expect(h.adapters).toHaveLength(1);
});

test('concurrentSameHostIsRejectedIncludingAddressChanges', async () => {
  const h = setup(); h.registry.add(request(100), 'session');
  expect(() => h.registry.add(request(101), 'other-session')).toThrow();
  h.registry.add(request(102, '10.2.3.5'), 'session'); await drain(); await succeed(h.adapters[1]!);
  expect(() => h.registry.get(h.repository.legacyId()!)!.start({ action: 'change_address', host: '10.2.3.4' })).toThrow();
});

test('failedAddKeepsExistingTvAndExpiresTerminalDraftAfterTenMinutes', async () => {
  const h = setup(); const first = h.registry.add(request(100), 'session'); await drain(); await succeed(h.adapters[0]!);
  const second = h.registry.add(request(101, '10.2.3.5'), 'session'); await drain();
  h.adapters[1]!.pairResult.reject(new WebOsError('PAIRING_REJECTED', 'synthetic rejection')); await drain();
  expect((await h.registry.list()).map((tv) => tv.tvId)).toEqual([first.tvId]);
  expect(h.registry.get(second.tvId)).not.toBeNull(); h.scheduler.advance(599_999); await drain(); expect(h.registry.get(second.tvId)).not.toBeNull();
  h.scheduler.advance(1); await drain(); expect(h.registry.get(second.tvId)).toBeNull();
  expect(() => h.registry.add(request(101, '10.2.3.5'), 'session')).toThrow();
});

test('closesAllAfterOneCloseFailure', async () => {
  const h = setup(); h.registry.add(request(100), 'session'); h.registry.add(request(101, '10.2.3.5'), 'session'); await drain();
  h.adapters[0]!.disconnectResult = Promise.reject(new Error('synthetic cleanup failure'));
  // Prevent an unobserved rejection before close owns the failure.
  void h.adapters[0]!.disconnectResult.catch(() => undefined);
  await expect(h.registry.close()).rejects.toThrow(); expect(h.adapters[1]!.closed).toBe(true);
  cleanups.pop();
});

test('cancelledDraftKeepsAddressReservedUntilAdapterCleanupSettles', async () => {
  const h = setup(); const accepted = h.registry.add(request(100), 'session'); await drain();
  const released = barrier<void>(); h.adapters[0]!.disconnectResult = released.promise;
  h.registry.get(accepted.tvId)!.cancel(accepted.operation.id); await drain();
  try { expect(() => h.registry.add(request(101), 'session')).toThrow(new TvServiceError('DUPLICATE_TV_HOST', 409)); }
  finally { released.resolve(); await drain(); }
  expect(h.registry.add(request(101), 'session').tvId).not.toBe(accepted.tvId);
});
