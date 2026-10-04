import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { WebOsError, loadClientKeyCipher } from '@remote-webos-tv/webos';
import { createApiRuntime } from '../src/runtime.js';
import { openDatabase, type AppDatabase } from '../src/storage/database.js';
import { createTvRepository } from '../src/tv/repository.js';
import { schemaMigrations } from '../src/storage/migrations.js';
import type { AppConfig } from '../src/config.js';
import { barrier, ControlledAdapter, ControlledScheduler, drain, succeed } from './support/tv-harness.js';
import { createOwnerRepository } from '../src/auth/repository.js';
import { createOwnerSetupService } from '../src/auth/service.js';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import { formatStartupError } from '../src/startup-errors.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tv-runtime-'));
  directories.push(directory);
  const config: AppConfig = { dataDir: directory, host: '127.0.0.1', port: 0, publicOrigin: 'https://remote.example.test', secureCookies: true, trustedProxy: [] };
  const adapters: ControlledAdapter[] = [];
  const policies: Array<{ host: string; timeout: number; prompt: boolean }> = [];
  const scheduler = new ControlledScheduler();
  let database!: AppDatabase;
  const logs: string[] = [];
  const options = {
    now: () => 1_000_000, scheduler,
    logStream: new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } }),
    openDatabase: async (input: Parameters<typeof openDatabase>[0]) => { database = await openDatabase(input); return database; },
    createAdapter(host: string, staging: ConstructorParameters<typeof ControlledAdapter>[0], timeout: number, prompt: boolean) {
      policies.push({ host, timeout, prompt });
      const adapter = new ControlledAdapter(staging); adapters.push(adapter); return adapter;
    },
  };
  return { config, adapters, policies, options, logs, database: () => database };
}

async function authenticate(app: Awaited<ReturnType<typeof createApiRuntime>>, database: AppDatabase, config: AppConfig) {
  const setup = createOwnerSetupService({ repository: createOwnerRepository(database.sqlite), now: () => 1_000_000 });
  const token = await setup.issueSetupToken();
  await setup.claimOwner({ token, username: 'owner', password: 'synthetic password 123' });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.publicOrigin }, payload: { username: 'owner', password: 'synthetic password 123' } });
  const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
  const session = await app.inject({ url: '/api/auth/session', headers: { cookie } });
  return { cookie, origin: config.publicOrigin, 'x-csrf-token': session.json().csrfToken as string };
}

test('runtime migrates existing owner storage, persists TV, and reconnects without a prompt after restart', async () => {
  const f = await fixture();
  const v1 = new Database(join(f.config.dataDir, 'app.sqlite'));
  schemaMigrations[0]!.up(v1);
  v1.prepare('INSERT INTO migration_version VALUES (1, 100)').run();
  const setup = createOwnerSetupService({ repository: createOwnerRepository(v1) });
  const token = await setup.issueSetupToken();
  await setup.claimOwner({ token, username: 'owner', password: 'synthetic password 123' });
  v1.close();
  let app = await createApiRuntime(f.config, f.options);
  try {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: f.config.publicOrigin }, payload: { username: 'owner', password: 'synthetic password 123' } });
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const session = await app.inject({ url: '/api/auth/session', headers: { cookie } });
    const headers = { cookie, origin: f.config.publicOrigin, 'x-csrf-token': session.json().csrfToken as string };
    const accepted = await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } });
    expect(accepted.statusCode).toBe(202);
    await succeed(f.adapters[0]!);
    expect(createTvRepository(f.database().sqlite).load()).toMatchObject({ host: '192.168.1.10', identity: { model: 'Synthetic Model' } });
    expect(f.policies[0]).toMatchObject({ timeout: 60_000, prompt: true });
    await app.close();
    app = await createApiRuntime(f.config, f.options);
    const reconnect = await f.adapters[1]!.enteredPair.promise;
    expect(reconnect.clientKey).toBe('synthetic-key');
    expect(f.policies[1]).toMatchObject({ prompt: false });
    const response = await app.inject({ url: '/api/tv', headers });
    expect(response.json()).toMatchObject({ tv: { host: '192.168.1.10', identity: { model: 'Synthetic Model' } }, connection: 'connecting' });
    expect(response.body).not.toMatch(/synthetic-key|encrypted|clientKey|master/);
    f.adapters[1]!.pairResult.reject(new WebOsError('NETWORK_UNREACHABLE', 'synthetic raw error'));
    await drain();
    expect((await app.inject({ url: '/api/tv', headers })).json()).toMatchObject({ tv: { host: '192.168.1.10' }, connection: 'connecting', operation: { action: 'reconnect', status: 'running' } });
    expect(f.logs.join('')).not.toMatch(/192\.168\.1\.10|synthetic-key|synthetic raw error/);
  } finally { await app.close(); }
});

test('runtime shutdown awaits pending TV cleanup before closing SQLite', async () => {
  const f = await fixture();
  const app = await createApiRuntime(f.config, f.options);
  const headers = await authenticate(app, f.database(), f.config);
  const accepted = await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } });
  expect(accepted.statusCode).toBe(202);
  const request = await f.adapters[0]!.enteredPair.promise;
  const cleanup = barrier<void>();
  f.adapters[0]!.disconnectResult = cleanup.promise;
  const aborted = new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
  const closing = app.close();
  await aborted;
  expect(request.signal.aborted).toBe(true);
  expect(f.database().sqlite.open).toBe(true);
  cleanup.resolve();
  await closing;
  expect(f.database().sqlite.open).toBe(false);
  const reopened = await openDatabase({ dataDir: f.config.dataDir });
  try { expect(createTvRepository(reopened.sqlite).hasStoredKey()).toBe(false); }
  finally { reopened.close(); }
});

test('runtime wires commands; shutdown aborts HTTP command then awaits adapter work before SQLite closes', async () => {
  const f = await fixture();
  const app = await createApiRuntime(f.config, f.options);
  const headers = await authenticate(app, f.database(), f.config);
  const command = { id: '00000000-0000-4000-8000-000000000001', button: 'HOME' };
  const gate = barrier<void>();
  let closing: Promise<void> | undefined;
  try {
    expect((await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } })).statusCode).toBe(202);
    await succeed(f.adapters[0]!);
    expect((await app.inject({ url: '/api/tv/remote', headers })).json()).toEqual({ enabled: true, reason: null });
    const adapter = f.adapters[0]!;
    adapter.sendResult = gate.promise;
    const pending = app.inject({ method: 'POST', url: '/api/tv/commands', headers, payload: command });
    const signal = await adapter.enteredSend.promise;
    const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    let closed = false;
    closing = app.close().then(() => { closed = true; });
    await aborted;
    expect(signal.aborted).toBe(true);
    expect((await pending).json()).toMatchObject({ id: command.id, outcome: 'unknown' });
    await drain();
    expect(closed).toBe(false);
    expect(f.database().sqlite.open).toBe(true);
    gate.resolve();
    await closing;
    expect(adapter.closed).toBe(true);
    expect(f.database().sqlite.open).toBe(false);
  } finally { gate.resolve(); await (closing ?? app.close()); }
});

test('runtime logout revokes its owned command and a new login keeps the saved TV without repeating it', async () => {
  const f = await fixture();
  const app = await createApiRuntime(f.config, f.options);
  const headers = await authenticate(app, f.database(), f.config);
  const gate = barrier<void>();
  try {
    await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } });
    await succeed(f.adapters[0]!);
    const adapter = f.adapters[0]!;
    adapter.sendResult = gate.promise;
    const command = { id: '00000000-0000-4000-8000-000000000001', button: 'HOME' };
    const pending = app.inject({ method: 'POST', url: '/api/tv/commands', headers, payload: command });
    const signal = await adapter.enteredSend.promise;
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode).toBe(204);
    expect(signal.aborted).toBe(true);
    expect((await pending).json()).toMatchObject({ id: command.id, outcome: 'unknown' });
    gate.resolve(); await drain();
    expect((await app.inject({ url: '/api/auth/session', headers })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: f.config.publicOrigin }, payload: { username: 'owner', password: 'synthetic password 123' } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    expect((await app.inject({ url: '/api/tv/remote', headers: { cookie } })).json()).toEqual({ enabled: true, reason: null });
    expect(createTvRepository(f.database().sqlite).hasStoredKey()).toBe(true);
    expect(adapter.sent).toEqual(['HOME']);
    expect(f.adapters).toHaveLength(1);
  } finally { gate.resolve(); await app.close(); }
});

test('runtime shutdown awaits held command admission before closing session storage', async () => {
  const f = await fixture();
  const app = await createApiRuntime(f.config, f.options);
  const headers = await authenticate(app, f.database(), f.config);
  await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } });
  await succeed(f.adapters[0]!);
  const entered = barrier<void>();
  const release = barrier<void>();
  const createLimiter = app.createRateLimit.bind(app);
  vi.spyOn(app, 'createRateLimit').mockImplementation((options) => {
    const limiter = createLimiter(options);
    return async (request, callOptions) => {
      if (options?.max === 10 && callOptions?.increment === false) { entered.resolve(); await release.promise; }
      return limiter(request, callOptions);
    };
  });
  const pending = app.inject({ method: 'POST', url: '/api/tv/commands', headers, payload: { id: '00000000-0000-4000-8000-000000000001', button: 'HOME' } });
  await entered.promise;
  let closed = false;
  const closing = app.close().then(() => { closed = true; });
  try {
    // One event-loop turn lets Fastify run nextTick close hooks; the held
    // limiter controls the race window, rather than any elapsed-time delay.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(f.database().sqlite.open).toBe(true);
    release.resolve();
    const response = await pending;
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ outcome: 'rejected', error: { code: 'COMMAND_NOT_SENT' } });
    expect(f.adapters[0]!.sent).toEqual([]);
    await closing;
    expect(f.database().sqlite.open).toBe(false);
  } finally { release.resolve(); await pending; await closing; }
});

test('corrupt TV cipher fails before HTTP and closes startup SQLite', async () => {
  const f = await fixture();
  await writeFile(join(f.config.dataDir, 'tv-master.key'), 'corrupt synthetic cipher');
  const error = await createApiRuntime(f.config, f.options).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: 'KEY_STORE_CORRUPT' });
  expect(formatStartupError(error)).toBe('API startup failed [KEY_STORE_CORRUPT]');
  expect(f.database().sqlite.open).toBe(false);
  expect(f.adapters).toHaveLength(0);
  await unlink(join(f.config.dataDir, 'tv-master.key'));
});

test('missing cipher with stored TV fails instead of creating a replacement key', async () => {
  const f = await fixture();
  const database = await openDatabase({ dataDir: f.config.dataDir });
  const cipher = await loadClientKeyCipher({ directory: f.config.dataDir, hasStoredKey: false });
  createTvRepository(database.sqlite).replace({ host: '192.168.1.10', identity: { model: 'Synthetic Model' }, macAddress: null, encryptedClientKey: cipher.encrypt('synthetic-key') });
  database.close();
  await unlink(join(f.config.dataDir, 'tv-master.key'));
  await expect(createApiRuntime(f.config, f.options)).rejects.toThrow('TV master key is missing or invalid');
  expect(f.database().sqlite.open).toBe(false);
  expect(f.adapters).toHaveLength(0);
});

test('migration failure prevents cipher and adapter startup and retains original schema', async () => {
  const f = await fixture();
  const original = new Database(join(f.config.dataDir, 'app.sqlite'));
  schemaMigrations[0]!.up(original);
  original.prepare('INSERT INTO migration_version VALUES (1, 100)').run();
  original.close();
  await expect(createApiRuntime(f.config, { ...f.options, openDatabase: (input) => openDatabase({ ...input, now: () => { throw new Error('synthetic migration failure'); } }) })).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED' });
  expect(f.adapters).toHaveLength(0);
  const unchanged = new Database(join(f.config.dataDir, 'app.sqlite'));
  try { expect(unchanged.prepare('SELECT version FROM migration_version').all()).toEqual([{ version: 1 }]); }
  finally { unchanged.close(); }
});

test('failure after TV initialization cleans the partially started service before SQLite', async () => {
  const f = await fixture();
  const seed = await openDatabase({ dataDir: f.config.dataDir });
  const cipher = await loadClientKeyCipher({ directory: f.config.dataDir, hasStoredKey: false });
  createTvRepository(seed.sqlite).replace({ host: '192.168.1.10', identity: { model: 'Synthetic Model' }, macAddress: null, encryptedClientKey: cipher.encrypt('synthetic-key') });
  seed.close();
  const cleanup = barrier<void>();
  const enteredCleanup = barrier<void>();
  const startup = createApiRuntime({ ...f.config, secureCookies: false }, {
    ...f.options, createAdapter(host, staging, timeout, prompt) {
      const adapter = f.options.createAdapter(host, staging, timeout, prompt);
      adapter.disconnect = async () => { enteredCleanup.resolve(); await cleanup.promise; };
      return adapter;
    },
  });
  const failure = startup.catch((cause: unknown) => cause);
  await enteredCleanup.promise;
  expect(f.database().sqlite.open).toBe(true);
  cleanup.resolve();
  expect(await failure).toBeInstanceOf(Error);
  expect(f.database().sqlite.open).toBe(false);
  const reopened = await openDatabase({ dataDir: f.config.dataDir });
  try { expect(createTvRepository(reopened.sqlite).hasStoredKey()).toBe(true); }
  finally { reopened.close(); }
});

test('shutdown preserves both TV and SQLite cleanup failures and safely reports every cause', async () => {
  const f = await fixture();
  const logs: string[] = [];
  const app = await createApiRuntime(f.config, { ...f.options, logStream: new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } }) });
  const headers = await authenticate(app, f.database(), f.config);
  await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } });
  await f.adapters[0]!.enteredPair.promise;
  const tvCause = new TypeError('synthetic-secret 192.168.1.10');
  f.adapters[0]!.disconnectResult = Promise.reject(tvCause);
  void f.adapters[0]!.disconnectResult.catch(() => {});
  const databaseCause = new SyntaxError('synthetic database path');
  const close = f.database().close;
  vi.spyOn(f.database(), 'close').mockImplementation(() => { close(); throw databaseCause; });
  const error = await app.close().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toHaveLength(2);
  expect((error as AggregateError).errors[1]).toBe(databaseCause);
  expect(f.database().sqlite.open).toBe(false);
  expect(logs.join('')).toMatch(/TypeError/);
  expect(logs.join('')).toMatch(/SyntaxError/);
  expect(logs.join('')).not.toMatch(/synthetic-secret|192\.168\.1\.10|synthetic database path/);
});
