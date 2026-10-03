import { describe, expect, test } from 'vitest';
import { tvStatusResponseSchema } from '@remote-webos-tv/contracts';
import { Lgtv2Adapter, createLgtv2Client, createClientKeyCipher, WebOsError } from '@remote-webos-tv/webos';
import Database from 'better-sqlite3';
import { createTvService, type TvServiceDependencies } from '../src/tv/service.js';
import { createTvRepository } from '../src/tv/repository.js';
import { tvConfigTableSql } from '../src/storage/migrations.js';
import { createStagingKeyStore } from '../src/tv/staging-key-store.js';
import { harness, succeed, drain, pairing, snapshot, barrier, ControlledScheduler } from './support/tv-harness.js';

describe('TV service persistence and projection', () => {
  test('commits encrypted TV only after registration and safe snapshot succeed', async () => {
    const h = harness();
    const operation = h.service.start({ action: 'pair', host: '192.168.1.10' });
    expect(operation).toMatchObject({ id: 'operation-1', status: 'running', startedAt: 1_000_000, deadlineAt: 1_060_000 });
    await drain();
    const adapter = h.adapters[0]!;
    await adapter.staging.save(pairing.clientKey);
    adapter.pairResult.resolve(pairing);
    await adapter.enteredRead.promise;
    expect(h.repository.load()).toBeNull();
    adapter.readResult.resolve(snapshot);
    await drain();
    const status = await h.service.status();
    expect(status).toMatchObject({ tv: { host: '192.168.1.10', identity: { model: 'Synthetic Model' } }, connection: 'available', operation: { status: 'succeeded' } });
    expect(h.cipher.decrypt(h.repository.load()!.encryptedClientKey)).toBe('synthetic-key');
    expect(h.writes).toHaveLength(1);
    expect(tvStatusResponseSchema.safeParse(status).success).toBe(true);
    expect(JSON.stringify(status)).not.toContain('synthetic-key');
    expect(JSON.stringify(status)).not.toContain('encryptedClientKey');
    await h.service.close();
  });

  test.each([
    ['PAIRING_REJECTED', 'authorization_error'],
    ['NETWORK_UNREACHABLE', 'unavailable'],
    ['INVALID_TV_RESPONSE', 'compatibility_error'],
    ['UNSUPPORTED_CAPABILITY', 'compatibility_error'],
  ] as const)('keeps permanent storage empty on %s after staging save', async (code, connection) => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!; await adapter.staging.save('synthetic-key');
    adapter.pairResult.reject(new WebOsError(code, 'raw private detail'));
    await drain();
    const status = await h.service.status();
    expect(status).toMatchObject({ tv: null, connection, operation: { status: 'failed', error: { code } } });
    expect(h.writes).toEqual([]); expect(adapter.closed).toBe(true);
    expect(JSON.stringify(status)).not.toContain('raw private detail'); await h.service.close();
  });

  test('rejects registered result without a client key', async () => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    h.adapters[0]!.pairResult.resolve({ ...pairing, clientKey: '' }); await drain();
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'INVALID_TV_RESPONSE' } });
    expect(h.writes).toEqual([]); await h.service.close();
  });

  test('does not commit after readSnapshot fails following registration', async () => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!; await adapter.staging.save('synthetic-key'); adapter.pairResult.resolve(pairing);
    await adapter.enteredRead.promise; adapter.readResult.reject(new WebOsError('CONNECTION_LOST', 'private'));
    await drain(); expect(h.repository.load()).toBeNull();
    expect((await h.service.status()).connection).toBe('unavailable'); await h.service.close();
  });

  test('staging clear never clears another operation key', async () => {
    const first = createStagingKeyStore('first-synthetic'); const second = createStagingKeyStore();
    await second.save('second-synthetic'); await first.clear();
    expect(await first.load()).toBeUndefined(); expect(await second.load()).toBe('second-synthetic');
  });

  test('maps invalid action, unknown cancel and concurrent start to safe HTTP errors', async () => {
    const h = harness();
    expect(() => h.service.start({ action: 'repair' })).toThrowError(expect.objectContaining({ statusCode: 409 }));
    expect(() => h.service.cancel('unknown')).toThrowError(expect.objectContaining({ statusCode: 404 }));
    h.service.start({ action: 'pair', host: '192.168.1.10' });
    expect(() => h.service.start({ action: 'pair', host: '192.168.1.11' })).toThrowError(expect.objectContaining({ statusCode: 409 }));
    await drain(); expect(h.adapters).toHaveLength(1); await h.service.close();
  });

  test('successful commit makes a later cancel an unchanged success', async () => {
    const h = harness(); const operation = h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    await succeed(h.adapters[0]!);
    expect(h.service.cancel(operation.id).status).toBe('succeeded'); expect(h.writes).toHaveLength(1); await h.service.close();
  });

  test('real mock-TV pair survives service restart and saved registration needs no new PROMPT', async () => {
    const fixture = await protocolFixture('success');
    let service = createTvService(fixture.dependencies);
    try {
      service.start({ action: 'pair', host: '192.168.1.10' }); await fixture.committed.promise; await drain();
      expect((await service.status()).connection).toBe('available');
      expect(fixture.mock.pairingPromptCount).toBe(1);
      expect(fixture.cipher.decrypt(fixture.repository.load()!.encryptedClientKey)).toBe('synthetic-mock-client-key');
      await service.close(); fixture.resetRead();
      service = createTvService(fixture.dependencies); await service.initialize(); await fixture.readFinished.promise; await drain();
      expect((await service.status()).connection).toBe('available'); expect(fixture.mock.pairingPromptCount).toBe(1);
      expect(fixture.sql.prepare('SELECT count(*) AS count FROM tv_config').get()).toEqual({ count: 1 });
    } finally { await service.close(); await fixture.mock.stop(); fixture.sql.close(); }
  });

  test('real mock-TV identity failure after saveKey never commits SQLite', async () => {
    const fixture = await protocolFixture('identity-loss'); const service = createTvService(fixture.dependencies);
    try {
      service.start({ action: 'pair', host: '192.168.1.10' }); await fixture.staged.promise;
      await fixture.cleaned.promise; await drain();
      expect(fixture.repository.load()).toBeNull();
      expect((await service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'CONNECTION_LOST' } });
    } finally { await service.close(); await fixture.mock.stop(); fixture.sql.close(); }
  });

  test('a failed permanent write preserves saved TV and exposes only its safe cause', async () => {
    const h = harness(true); const original = h.repository.load();
    h.repository.replace = () => { throw new Error('private SQLite path'); };
    h.service.start({ action: 'change_address', host: '192.168.1.11' }); await drain(); await succeed(h.adapters[0]!);
    expect(h.repository.load()).toEqual(original);
    const status = await h.service.status();
    expect(status.operation).toMatchObject({ status: 'failed', error: { code: 'STORAGE_FAILED' } });
    expect(JSON.stringify(status)).not.toContain('private SQLite path'); await h.service.close();
  });

  test('encryption failure after registration cannot replace an existing setup', async () => {
    const base = harness(true); const original = base.repository.load();
    const h = harness(true, { repository: base.repository, cipher: { ...base.cipher, encrypt() { throw new Error('private cipher detail'); } } });
    h.service.start({ action: 'repair' }); await drain(); await succeed(h.adapters[0]!);
    expect(base.repository.load()).toEqual(original);
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'KEY_STORE_WRITE_FAILED' } });
    await h.service.close(); await base.service.close();
  });
});

async function protocolFixture(scenario: 'success' | 'identity-loss') {
  // Deliberately test-only dynamic import: the protocol fixture is not in API production output.
  const { MockWebOsTv } = await import(new URL('../../../packages/webos/test/support/mock-webos-tv.js', import.meta.url).href);
  const mock = new MockWebOsTv({ scenario: scenario === 'success' ? { kind: 'success' } : { kind: 'close-before-response', uri: 'ssap://system/getSystemInfo' } });
  await mock.start();
  const sql = new Database(':memory:'); sql.exec(tvConfigTableSql);
  const repository = createTvRepository(sql);
  const cipher = createClientKeyCipher(Buffer.alloc(32, 7));
  const committed = barrier<void>(); const staged = barrier<void>();
  const cleaned = barrier<void>();
  let readFinished = barrier<void>();
  let id = 0;
  const dependencies: TvServiceDependencies = {
    repository: { ...repository, replace(value) { repository.replace(value); committed.resolve(); } }, cipher,
    scheduler: new ControlledScheduler(), now: () => 1_000_000, newId: () => `mock-operation-${++id}`,
    createAdapter(host, staging, requestTimeoutMs, allowPairingPrompt) {
      const adapter = new Lgtv2Adapter({ host, keyStore: { ...staging, async save(key) { await staging.save(key); staged.resolve(); } }, requestTimeoutMs, allowPairingPrompt, handshakeTimeoutMs: 500, now: () => new Date(1_000_000) }, {
        createClient(options) {
          const port = Number(new URL(mock.url).port);
          return createLgtv2Client({ ...options, host: '127.0.0.1', ports: { secure: port, insecure: port }, verifyCert: false });
        },
      });
      const readSnapshot = adapter.readSnapshot.bind(adapter);
      adapter.readSnapshot = async (signal) => { const value = await readSnapshot(signal); readFinished.resolve(); return value; };
      const disconnect = adapter.disconnect.bind(adapter);
      adapter.disconnect = async () => { await disconnect(); cleaned.resolve(); };
      return adapter;
    },
  };
  return { mock, sql, repository, cipher, committed, staged, cleaned, dependencies, get readFinished() { return readFinished; }, resetRead() { readFinished = barrier<void>(); } };
}
