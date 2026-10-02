import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { openDatabase } from '../src/storage/database.js';
import { AuthMasterKeyStorageError } from '../src/auth/sessions.js';
import { AppConfigError } from '../src/config.js';
import { createApiRuntime } from '../src/runtime.js';
import { formatStartupError } from '../src/startup-errors.js';

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

test('CLI reports missing auth master key as a safe storage error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-startup-'));
  const dataDir = join(directory, 'data');
  try {
    const database = await openDatabase({ dataDir });
    try {
      database.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (1, ?, ?)').run('alice', 'synthetic-hash');
      database.sqlite.prepare('INSERT INTO sessions (token_hash, owner_id, created_at, expires_at, csrf_hash) VALUES (?, 1, ?, ?, ?)').run('synthetic-token-hash', 1, 2, 'synthetic-csrf-hash');
    } finally { database.close(); }

    const build = spawnSync('pnpm', ['--filter', '@remote-webos-tv/api', 'build'], {
      cwd: workspaceRoot, encoding: 'utf8',
    });
    expect(build.status, build.stderr).toBe(0);

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
