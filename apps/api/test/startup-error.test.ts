import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';

import { openDatabase } from '../src/storage/database.js';
import { AuthMasterKeyStorageError } from '../src/auth/sessions.js';
import { AppConfigError } from '../src/config.js';
import { createApiRuntime } from '../src/runtime.js';
import { formatStartupError } from '../src/startup-errors.js';
import { schemaMigrations } from '../src/storage/migrations.js';
import { runSetupTokenCli } from '../src/auth/cli.js';

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));
const tokenCliPath = fileURLToPath(new URL('../dist/src/auth/cli.js', import.meta.url));

beforeAll(() => {
  const build = spawnSync('pnpm', ['--filter', '@remote-webos-tv/api', 'build'], { cwd: workspaceRoot, encoding: 'utf8' });
  expect(build.status, build.stderr).toBe(0);
}, 15_000);

test.each([
  ['newer', 'STORAGE_SCHEMA_NEWER', undefined],
  ['corrupt', 'STORAGE_SCHEMA_INVALID', 'SQLITE_NOTADB'],
  ['occupied', 'STORAGE_OPEN_FAILED', 'EEXIST'],
] as const)('API and setup CLI preserve safe %s diagnostics and fail without secrets', async (kind, code, causeCode) => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-startup-codes-'));
  const dataDir = join(directory, 'data');
  try {
    if (kind === 'newer') {
      const db = await openDatabase({ dataDir });
      db.sqlite.prepare('INSERT INTO migration_version (version, applied_at) VALUES (99, 1)').run();
      db.close();
    } else if (kind === 'corrupt') {
      await mkdir(dataDir);
      await writeFile(join(dataDir, 'app.sqlite'), 'synthetic-secret-that-must-not-escape');
    } else {
      await writeFile(dataDir, 'synthetic-secret-that-must-not-escape');
    }
    for (const [entry, args] of [[cliPath, []], [tokenCliPath, ['setup-token']]] as const) {
      const start = spawnSync(process.execPath, [entry, ...args], {
        cwd: workspaceRoot, encoding: 'utf8', timeout: 10_000,
        env: { REMOTE_WEBOS_DATA_DIR: dataDir, REMOTE_WEBOS_PUBLIC_ORIGIN: 'https://remote.example.test', REMOTE_WEBOS_HOST: '127.0.0.1', REMOTE_WEBOS_PORT: '18080' },
      });
      expect(start.status).toBe(1);
      expect.soft(start.stderr).toContain(code);
      if (causeCode) expect.soft(start.stderr).toContain(causeCode);
      expect(start.stdout).not.toContain('API listening');
      expect(start.stderr.length).toBeLessThan(500);
      expect(start.stderr).not.toContain(directory);
      expect(start.stderr).not.toMatch(/synthetic-secret|Error:| at /);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('migration and cleanup failures retain separate safe codes and original causes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-migration-codes-'));
  let connection: Database.Database | undefined;
  const primary = Object.assign(new Error('synthetic-secret-migration'), { code: 'SQLITE_FULL' });
  const cleanup = Object.assign(new Error('synthetic-secret-close'), { code: 'EIO' });
  const close = vi.spyOn(Database.prototype, 'close').mockImplementationOnce(() => { throw cleanup; });
  try {
    const failure = await openDatabase({ dataDir: join(directory, 'data'), migrations: [...schemaMigrations, {
      version: 2, up(sqlite) { connection = sqlite; throw primary; },
    }] }).catch((error: unknown) => error);
    const diagnostic = formatStartupError(failure);
    expect.soft(diagnostic).toContain('STORAGE_MIGRATION_FAILED');
    expect.soft(diagnostic).toContain('SQLITE_FULL');
    expect.soft(diagnostic).toContain('STORAGE_CLOSE_FAILED');
    expect.soft(diagnostic).toContain('EIO');
    expect(diagnostic).not.toMatch(/synthetic-secret/);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toMatchObject({ cause: primary });
    expect((failure as AggregateError).errors[1]).toMatchObject({ cause: cleanup });
  } finally {
    close.mockRestore();
    connection?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup cause diagnostics allowlist codes and bound cyclic error graphs', () => {
  const safe = Object.assign(new Error('synthetic-secret'), { code: 'EACCES' });
  safe.cause = safe;
  expect(formatStartupError(safe)).toContain('EACCES');
  const arbitrary = Object.assign(new Error('synthetic-secret'), { code: 'SECRET_ACCOUNT_TOKEN' });
  expect(formatStartupError(arbitrary)).toBe('API startup failed');
  expect(formatStartupError(new AggregateError(Array(100).fill(safe), 'synthetic-secret')).length).toBeLessThan(500);
});

test('runtime initialization keeps auth failure when database cleanup also fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-runtime-cleanup-'));
  let connection: Database.Database | undefined;
  const close = vi.spyOn(Database.prototype, 'close').mockImplementationOnce(function (this: Database.Database) {
    connection = this;
    throw Object.assign(new Error('synthetic-secret-close'), { code: 'EIO' });
  });
  try {
    const failure = await createApiRuntime({ dataDir: join(directory, 'data'), host: '127.0.0.1', port: 18080,
      publicOrigin: 'http://127.0.0.1', secureCookies: false, trustedProxy: [],
    }, { randomBytes: () => Buffer.alloc(0) }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBeInstanceOf(AuthMasterKeyStorageError);
    expect(formatStartupError(failure)).toContain('AUTH_STORAGE_UNAVAILABLE');
    expect(formatStartupError(failure)).toContain('STORAGE_CLOSE_FAILED');
    expect(formatStartupError(failure)).not.toContain('synthetic-secret');
  } finally { close.mockRestore(); connection?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('setup CLI keeps the owner failure and close cause without emitting a token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-cli-cleanup-'));
  const dataDir = join(directory, 'data');
  const first = await openDatabase({ dataDir });
  first.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (1, ?, ?)').run('alice', 'synthetic-hash');
  first.close();
  let connection: Database.Database | undefined;
  const close = vi.spyOn(Database.prototype, 'close').mockImplementationOnce(function (this: Database.Database) {
    connection = this;
    throw Object.assign(new Error('synthetic-secret-close'), { code: 'EIO' });
  });
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await runSetupTokenCli({ args: ['setup-token'], env: { REMOTE_WEBOS_DATA_DIR: dataDir }, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) })).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('SETUP_UNAVAILABLE');
    expect(stderr.join('')).toContain('STORAGE_CLOSE_FAILED');
    expect(stderr.join('')).toContain('EIO');
    expect(stderr.join('')).not.toContain('synthetic-secret');
  } finally { close.mockRestore(); connection?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('CLI reports missing auth master key as a safe storage error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-startup-'));
  const dataDir = join(directory, 'data');
  try {
    const database = await openDatabase({ dataDir });
    try {
      database.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (1, ?, ?)').run('alice', 'synthetic-hash');
      database.sqlite.prepare('INSERT INTO sessions (token_hash, owner_id, created_at, expires_at, csrf_hash) VALUES (?, 1, ?, ?, ?)').run('synthetic-token-hash', 1, 2, 'synthetic-csrf-hash');
    } finally { database.close(); }

    const start = spawnSync(process.execPath, [cliPath], {
      cwd: workspaceRoot, encoding: 'utf8',
      env: {
        ...process.env,
        REMOTE_WEBOS_DATA_DIR: dataDir,
        REMOTE_WEBOS_HOST: '127.0.0.1',
        REMOTE_WEBOS_PORT: '18080',
        REMOTE_WEBOS_PUBLIC_ORIGIN: 'https://remote.example.test',
        REMOTE_WEBOS_SECURE_COOKIES: 'true',
        REMOTE_WEBOS_TRUSTED_PROXY: '',
      },
    });
    expect(start.status).toBe(1);
    expect(start.stderr.trim()).toBe('Auth storage unavailable');
    expect(start.stderr).not.toContain(directory);
    expect(start.stderr).not.toMatch(/synthetic-token|synthetic-csrf|stack/i);
    try {
      await createApiRuntime({
        dataDir, host: '127.0.0.1', port: 18080,
        publicOrigin: 'https://remote.example.test', secureCookies: true, trustedProxy: [],
      });
      throw new Error('Expected startup to reject a missing auth master key');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthMasterKeyStorageError);
      expect((error as AuthMasterKeyStorageError).cause).toBeInstanceOf(Error);
      expect(formatStartupError(error)).toBe('Auth storage unavailable');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);

test('startup diagnostics expose only typed safe configuration errors', () => {
  expect(formatStartupError(new AppConfigError('REMOTE_WEBOS_PORT must be an integer from 1 to 65535'))).toBe('REMOTE_WEBOS_PORT must be an integer from 1 to 65535');
  expect(formatStartupError(new Error('REMOTE_WEBOS_SECRET=private-value'))).toBe('API startup failed');
});
