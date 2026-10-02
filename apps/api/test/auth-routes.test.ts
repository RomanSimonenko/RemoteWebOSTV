import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { createApiRuntime } from '../src/runtime.js';
import { createOwnerRepository } from '../src/auth/repository.js';
import { createOwnerSetupService } from '../src/auth/service.js';
import { openDatabase } from '../src/storage/database.js';

const directories: string[] = [];
const origin = 'https://remote.example.test';
const password = 'correct horse battery staple';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-auth-routes-'));
  directories.push(directory);
  const config: AppConfig = {
    dataDir: join(directory, 'data'), host: '127.0.0.1', port: 8080,
    publicOrigin: origin, secureCookies: true, trustedProxy: [],
  };
  const database = await openDatabase({ dataDir: config.dataDir });
  let token: string;
  try {
    token = await createOwnerSetupService({ repository: createOwnerRepository(database.sqlite) }).issueSetupToken();
  } finally { database.close(); }
  return { config, token };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test('setup claims one owner without logging in and protects exact Origin', async () => {
  const { config, token } = await fixture();
  const app = await createApiRuntime(config);
  try {
    const payload = { token, username: 'alice', password };
    for (const headers of [{}, { origin: 'https://foreign.example.test' }, { origin: `${origin}/` }]) {
      const response = await app.inject({ method: 'POST', url: '/api/setup', headers, payload });
      expect(response.statusCode).toBe(403);
    }
    const response = await app.inject({ method: 'POST', url: '/api/setup', headers: { origin }, payload });
    expect(response.statusCode).toBe(201);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).not.toMatch(/password|token|hash/i);
    expect((await app.inject('/api/auth/session')).statusCode).toBe(401);
    expect((await app.inject('/api/setup/status')).json()).toEqual({ state: 'claimed' });
    expect((await app.inject({ method: 'POST', url: '/api/setup', headers: { origin }, payload })).statusCode).toBe(403);
  } finally { await app.close(); }
});

test('login, restart, session and logout use persistent hashed sessions and CSRF', async () => {
  const { config, token } = await fixture();
  let now = 1_000_000;
  const first = await createApiRuntime(config, { now: () => now });
  let cookie: string;
  let csrfToken: string;
  try {
    expect((await first.inject({ method: 'POST', url: '/api/setup', headers: { origin }, payload: { token, username: 'alice', password } })).statusCode).toBe(201);
    const absent = await first.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'nobody', password } });
    const wrong = await first.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'alice', password: 'different-password-123' } });
    expect(absent.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect({ code: absent.json().code, message: absent.json().message }).toEqual({ code: wrong.json().code, message: wrong.json().message });
    const login = await first.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'alice', password } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ username: 'alice' });
    expect(login.headers['set-cookie']).toMatch(/^remote_webos_session=[A-Za-z0-9_-]{43};.*HttpOnly;.*SameSite=Strict/);
    expect(login.headers['set-cookie']).toContain('Secure');
    expect(login.headers['set-cookie']).toContain('Path=/');
    cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const session = await first.inject({ url: '/api/auth/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ username: 'alice', csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    csrfToken = session.json().csrfToken;
    const database = await openDatabase({ dataDir: config.dataDir });
    try {
      const row = database.sqlite.prepare('SELECT token_hash, csrf_hash, created_at, expires_at FROM sessions').get() as {
        token_hash: string; csrf_hash: string; created_at: number; expires_at: number;
      };
      expect(row).toEqual({
        token_hash: createHash('sha256').update(cookie.split('=')[1]!).digest('hex'),
        csrf_hash: createHash('sha256').update(csrfToken).digest('hex'),
        created_at: now,
        expires_at: now + 24 * 60 * 60 * 1000,
      });
      expect(row.token_hash).not.toContain(cookie.split('=')[1]!);
    } finally { database.close(); }
  } finally { await first.close(); }

  now += 1_000;
  const second = await createApiRuntime(config, { now: () => now });
  try {
    const session = await second.inject({ url: '/api/auth/session', headers: { cookie } });
    expect(session.json()).toEqual({ username: 'alice', csrfToken });
    for (const headers of [{ cookie, origin }, { cookie, origin, 'x-csrf-token': 'invalid' }, { cookie, origin: 'https://foreign.example.test', 'x-csrf-token': csrfToken }]) {
      expect((await second.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode).toBe(403);
    }
    expect((await second.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin, 'x-csrf-token': csrfToken } })).statusCode).toBe(204);
    expect((await second.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin, 'x-csrf-token': csrfToken } })).statusCode).toBe(401);
    expect((await second.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(401);
  } finally { await second.close(); }
});

test('session expiry is fixed and missing auth master key with stored sessions fails startup', async () => {
  const { config, token } = await fixture();
  let now = 1_000_000;
  const app = await createApiRuntime(config, { now: () => now });
  let cookie: string;
  try {
    await app.inject({ method: 'POST', url: '/api/setup', headers: { origin }, payload: { token, username: 'alice', password } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'alice', password } });
    cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    now += 12 * 60 * 60 * 1000;
    expect((await app.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(200);
    now += 12 * 60 * 60 * 1000;
    expect((await app.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(401);
  } finally { await app.close(); }
  const keyPath = join(config.dataDir, 'auth-master.key');
  expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  expect(await readFile(keyPath)).toHaveLength(32);
  await unlink(keyPath);
  await expect(createApiRuntime(config)).rejects.toThrow(/storage|master key/i);
});

test('HTTPS refuses an insecure cookie override', async () => {
  const { config } = await fixture();
  await expect(createApiRuntime({ ...config, secureCookies: false })).rejects.toThrow(/secure.*cookie|cookie.*secure/i);
});

test('encoded API aliases inherit Origin, session, CSRF and cache policies from their matched routes', async () => {
  const { config, token } = await fixture();
  const app = await createApiRuntime(config);
  app.get('/api/private', async () => ({ state: 'private' }));
  app.post('/api/private', async () => ({ applied: true }));
  try {
    for (const url of ['/%61pi/setup', '/api/auth/%6cogin']) {
      const denied = await app.inject({ method: 'POST', url, payload: { token, username: 'alice', password } });
      expect(denied.statusCode).toBe(403);
      expect(denied.headers['cache-control']).toBe('no-store');
    }
    for (const method of ['GET', 'POST'] as const) {
      const denied = await app.inject({ method, url: '/%61pi/private', headers: { origin } });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers['cache-control']).toBe('no-store');
    }
    expect((await app.inject({ method: 'POST', url: '/%61pi/setup', headers: { origin }, payload: { token, username: 'alice', password } })).statusCode).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/%61pi/auth/login', headers: { origin }, payload: { username: 'alice', password } });
    expect(login.statusCode).toBe(200);
    expect(login.headers['cache-control']).toBe('no-store');
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const session = await app.inject({ url: '/%61pi/auth/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.headers['cache-control']).toBe('no-store');
    const csrf = session.json().csrfToken as string;
    for (const url of ['/%61pi/private', '/%61pi/auth/logout']) {
      for (const headers of [{ cookie, origin }, { cookie, origin: 'https://foreign.example.test', 'x-csrf-token': csrf }]) {
        const denied = await app.inject({ method: 'POST', url, headers });
        expect(denied.statusCode).toBe(403);
        expect(denied.headers['cache-control']).toBe('no-store');
      }
    }
    expect((await app.inject({ method: 'POST', url: '/%61pi/private', headers: { cookie, origin, 'x-csrf-token': csrf } })).json()).toEqual({ applied: true });
    expect((await app.inject({ method: 'POST', url: '/%61pi/auth/logout', headers: { cookie, origin, 'x-csrf-token': csrf } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/%61pi/auth/session', headers: { cookie } })).statusCode).toBe(401);
  } finally { await app.close(); }
});

test('future API routes inherit session, Origin and CSRF guards', async () => {
  const { config, token } = await fixture();
  const app = await createApiRuntime(config);
  app.get('/api/future-state', async () => ({ state: 'private' }));
  app.post('/api/future-command', async () => ({ applied: true }));
  try {
    await app.inject({ method: 'POST', url: '/api/setup', headers: { origin }, payload: { token, username: 'alice', password } });
    expect((await app.inject('/api/future-state')).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'alice', password } });
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const csrf = (await app.inject({ url: '/api/auth/session', headers: { cookie } })).json().csrfToken as string;
    expect((await app.inject({ url: '/api/future-state', headers: { cookie } })).json()).toEqual({ state: 'private' });
    expect((await app.inject({ method: 'POST', url: '/api/future-command', headers: { cookie, 'x-csrf-token': csrf } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/future-command', headers: { cookie, origin } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/future-command', headers: { cookie, origin, 'x-csrf-token': csrf } })).json()).toEqual({ applied: true });
  } finally { await app.close(); }
});
