import { afterEach, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const origin = 'https://remote.example.test';
const config: AppConfig = {
  dataDir: '/synthetic/data', host: '127.0.0.1', port: 8080,
  publicOrigin: origin, secureCookies: true, trustedProxy: [],
};

function appFor(trustedProxy: readonly string[] = []) {
  return buildApp({
    config: { ...config, trustedProxy },
    getSetupState: async () => 'unclaimed',
    auth: {
      setup: { claimOwner: async () => { throw new Error('setup must not run'); } } as never,
      sessions: { login: async () => { throw new Error('login must not run'); }, authenticate: () => undefined } as never,
    },
  });
}

afterEach(() => vi.useRealTimers());

test.each(['/api/setup', '/api/auth/login'])('encoded aliases of %s share the canonical attempt limit', async (path) => {
  const app = appFor();
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await app.inject({ method: 'POST', url: attempt % 2 ? path : path.replace('/api/', '/%61pi/'), headers: { origin }, payload: {} });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    for (const url of [path, path.replace('/api/', '/%61pi/')]) {
      const blocked = await app.inject({ method: 'POST', url, headers: { origin }, payload: {} });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.headers['cache-control']).toBe('no-store');
    }
  } finally { await app.close(); }
});

test('setup and login share five attempts per source IP for sixty seconds', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const app = appFor();
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await app.inject({ method: 'POST', url: attempt % 2 ? '/api/auth/login' : '/api/setup', headers: { origin }, payload: {} });
      expect(response.statusCode).toBe(400);
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/login?password=query-secret', headers: { origin }, payload: { username: 'alice', password: 'valid-length-password' } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(blocked.json()).toEqual({ code: 'RATE_LIMITED', message: 'Too many requests', requestId: blocked.headers['x-request-id'] });
    expect((await app.inject({ method: 'POST', url: '/api/setup', headers: { origin }, payload: {} })).statusCode).toBe(429);
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect((await app.inject({ method: 'POST', url: '/api/setup', headers: { origin }, payload: {} })).statusCode).toBe(400);
  } finally { await app.close(); }
});

test('untrusted forwarding cannot rotate the source IP, while a configured proxy resolves its client', async () => {
  const direct = appFor();
  const proxied = appFor(['127.0.0.1']);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await direct.inject({ method: 'POST', url: '/api/auth/login', headers: { origin, 'x-forwarded-for': `192.0.2.${attempt + 1}` }, payload: {} });
      expect(response.statusCode).toBe(400);
    }
    expect((await direct.inject({ method: 'POST', url: '/api/auth/login', headers: { origin, 'x-forwarded-for': '192.0.2.99' }, payload: {} })).statusCode).toBe(429);

    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await proxied.inject({ method: 'POST', url: '/api/auth/login', headers: { origin, 'x-forwarded-for': '192.0.2.1' }, payload: {} })).statusCode).toBe(400);
    }
    expect((await proxied.inject({ method: 'POST', url: '/api/auth/login', headers: { origin, 'x-forwarded-for': '192.0.2.1' }, payload: {} })).statusCode).toBe(429);
    expect((await proxied.inject({ method: 'POST', url: '/api/auth/login', headers: { origin, 'x-forwarded-for': '192.0.2.2' }, payload: {} })).statusCode).toBe(400);
  } finally { await direct.close(); await proxied.close(); }
});
