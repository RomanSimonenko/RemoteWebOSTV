import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { WebOsError } from '@remote-webos-tv/webos';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/storage/database.js';
import { createOwnerRepository } from '../src/auth/repository.js';
import { createOwnerSetupService } from '../src/auth/service.js';
import { createAuthSessionService } from '../src/auth/sessions.js';
import { barrier, drain, harness } from './support/tv-harness.js';

const origin = 'https://remote.example.test';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tv-routes-'));
  const database = await openDatabase({ dataDir: directory });
  const repository = createOwnerRepository(database.sqlite);
  const setup = createOwnerSetupService({ repository });
  const token = await setup.issueSetupToken();
  await setup.claimOwner({ token, username: 'owner', password: 'synthetic password 123' });
  const sessions = await createAuthSessionService({ repository, masterKey: Buffer.alloc(32, 7) });
  const login = (await sessions.login('owner', 'synthetic password 123'))!;
  const cookie = `remote_webos_session=${login.token}`;
  const csrf = sessions.authenticate(login.token)!.csrfToken;
  const logs: string[] = [];
  const h = harness();
  const app = buildApp({
    config: { dataDir: directory, host: '127.0.0.1', port: 0, publicOrigin: origin, secureCookies: true, trustedProxy: [] },
    getSetupState: async () => repository.getSetupState(), auth: { setup, sessions }, tv: h.service,
    logStream: new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } }),
  });
  cleanups.push(async () => { await app.close(); await h.service.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, h, logs, headers: { cookie, origin, 'x-csrf-token': csrf } };
}

test('TV routes and encoded aliases enforce session, Origin, CSRF and no-store', async () => {
  const { app, headers } = await fixture();
  for (const url of ['/api/tv', '/%61pi/%74v']) {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  }
  for (const url of ['/api/tv/operations', '/%61pi/tv/%6fperations', '/api/tv/operations/unknown/cancel', '/api/tv/operations/unknown/%63ancel']) {
    for (const [requestHeaders, status] of [
      [{}, 403], [{ origin }, 401], [{ cookie: headers.cookie, origin }, 403],
      [{ ...headers, origin: 'https://foreign.example.test' }, 403], [{ ...headers, 'x-csrf-token': 'invalid' }, 403],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, headers: requestHeaders, payload: { action: 'pair', host: '192.168.1.10' } });
      expect(response.statusCode).toBe(status);
      expect(response.json().requestId).toBe(response.headers['x-request-id']);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  }
  expect((await app.inject({ url: '/api/tv', headers })).json()).toEqual({ tv: null, connection: 'unconfigured', operation: null });
});

test('TV routes validate strict payloads, safely project conflicts and retain async failures after 202', async () => {
  const { app, h, logs, headers } = await fixture();
  for (const payload of [{ action: 'pair', host: '192.168.1.10', key: 'synthetic-secret' }, { action: 'pair', host: '127.0.0.1' }, { action: 'pair' }]) {
    expect((await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload })).statusCode).toBe(400);
  }
  expect((await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'reconnect' } })).statusCode).toBe(409);
  const accepted = await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } });
  expect(accepted.statusCode).toBe(202);
  const conflict = await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().code).toBe('OPERATION_CONFLICT');
  h.adapters[0]!.pairResult.reject(new WebOsError('NETWORK_UNREACHABLE', 'synthetic-secret 192.168.1.10', { cause: new Error('raw-failure') }));
  await drain();
  const response = await app.inject({ url: '/api/tv', headers });
  expect(response.json().operation).toMatchObject({ id: accepted.json().id, status: 'failed', error: { code: 'NETWORK_UNREACHABLE' } });
  expect(response.body).not.toMatch(/synthetic-secret|raw-failure|clientKey|encrypted|master/);
  const unknown = await app.inject({ method: 'POST', url: '/api/tv/operations/unknown/cancel', headers });
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json().requestId).toBe(unknown.headers['x-request-id']);
  expect(logs.join('')).not.toMatch(/synthetic-secret|raw-failure|192\.168\.1\.10|clientKey/);
});

test('owner limit charges only accepted attempts, permits cancel, and expires at 60000ms', async () => {
  const { app, h, headers } = await fixture();
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  for (let index = 0; index < 5; index++) {
    expect((await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'reconnect' } })).statusCode).toBe(409);
    const accepted = await app.inject({ method: 'POST', url: '/api/tv/operations', headers, remoteAddress: `203.0.113.${index + 1}`, payload: { action: 'pair', host: '192.168.1.10' } });
    expect(accepted.statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } })).statusCode).toBe(409);
    const cancelled = await app.inject({ method: 'POST', url: `/api/tv/operations/${accepted.json().id}/cancel`, headers });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    await drain();
  }
  now += 59_001;
  const blocked = await app.inject({ method: 'POST', url: '/api/tv/operations', headers, remoteAddress: '203.0.113.99', payload: { action: 'pair', host: '192.168.1.10' } });
  expect(blocked.statusCode).toBe(429);
  expect(blocked.headers['retry-after']).toBe('1');
  expect(h.adapters).toHaveLength(5);
  now += 999;
  expect((await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } })).statusCode).toBe(202);
});

test('concurrent authenticated starts admit one operation and do not charge conflicts', async () => {
  const { app, h, headers } = await fixture();
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } })));
  expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409, 409, 409, 409, 409, 409, 409]);
  expect(h.adapters).toHaveLength(1);
  const closing = barrier<void>();
  h.adapters[0]!.disconnectResult = closing.promise;
  const cancel = await app.inject({ method: 'POST', url: `/api/tv/operations/${responses.find((response) => response.statusCode === 202)!.json().id}/cancel`, headers, payload: { extra: true } });
  expect(cancel.statusCode).toBe(400);
  closing.resolve();
});

test('unexpected TV status failures have safe requestId responses and safe cause diagnostics', async () => {
  const { app, h, logs, headers } = await fixture();
  vi.spyOn(h.service, 'status').mockRejectedValueOnce(new TypeError('synthetic-secret 192.168.1.10', { cause: new SyntaxError('raw-failure') }));
  const response = await app.inject({ url: '/api/tv', headers });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: response.headers['x-request-id'] });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(logs.join('')).toContain('TypeError');
  expect(logs.join('')).toContain('SyntaxError');
  expect(response.body + logs.join('')).not.toMatch(/synthetic-secret|192\.168\.1\.10|raw-failure/);
});
