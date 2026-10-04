import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { tvPowerOperationSchema, tvPowerStateSchema } from '@remote-webos-tv/contracts';
import { TvPowerSendError } from '@remote-webos-tv/webos';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/storage/database.js';
import { createOwnerRepository } from '../src/auth/repository.js';
import { createOwnerSetupService } from '../src/auth/service.js';
import { createAuthSessionService } from '../src/auth/sessions.js';
import { barrier, drain, harness, pairing, snapshot } from './support/tv-harness.js';

const origin = 'https://remote.example.test';
const id = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000101';
const off = { id, action: 'power_off', confirm: true } as const;
const wake = { id, action: 'wake' } as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(ready = true, powerOff = true, saved = true) {
  const directory = await mkdtemp(join(tmpdir(), 'tv-power-routes-'));
  const database = await openDatabase({ dataDir: directory });
  const repository = createOwnerRepository(database.sqlite);
  const setup = createOwnerSetupService({ repository });
  const setupToken = await setup.issueSetupToken();
  await setup.claimOwner({ token: setupToken, username: 'owner', password: 'synthetic password 123' });
  const sessions = await createAuthSessionService({ repository, masterKey: Buffer.alloc(32, 7) });
  const login = (await sessions.login('owner', 'synthetic password 123'))!;
  const headersFor = (token: string) => ({ cookie: `remote_webos_session=${token}`, origin, 'x-csrf-token': sessions.authenticate(token)!.csrfToken });
  let internalId = 1000;
  const h = harness(saved, { newId: () => `00000000-0000-4000-8000-${String(++internalId).padStart(12, '0')}` });
  if (ready) {
    h.service.start({ action: 'reconnect' }); await drain();
    const adapter = h.adapters[0]!;
    adapter.pairResult.resolve(pairing); await adapter.enteredRead.promise;
    adapter.readResult.resolve({ ...snapshot, capabilities: { ...snapshot.capabilities, powerOff } }); await drain();
  }
  const logs: string[] = [];
  const app = buildApp({
    config: { dataDir: directory, host: '127.0.0.1', port: 0, publicOrigin: origin, secureCookies: true, trustedProxy: [] },
    getSetupState: async () => repository.getSetupState(), auth: { setup, sessions }, tv: h.service,
    logStream: new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } }),
  });
  cleanups.push(async () => { await app.close(); await h.service.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = headersFor(login.token);
  const post = (payload: unknown = off, supplied = headers) => app.inject({ method: 'POST', url: '/api/tv/power', headers: { ...supplied, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  const cancel = (operationId = id, supplied = headers) => app.inject({ method: 'POST', url: `/api/tv/power/${operationId}/cancel`, headers: supplied });
  return { app, h, sessions, login, headers, headersFor, logs, post, cancel };
}

test('power routes enforce actual session, Origin, CSRF and no-store, including encoded aliases', async () => {
  const { app, h, headers } = await fixture();
  for (const url of ['/api/tv/power', '/%61pi/tv/%70ower']) {
    const denied = await app.inject(url);
    expect(denied.statusCode).toBe(401); expect(denied.headers['cache-control']).toBe('no-store');
    const state = await app.inject({ url, headers });
    expect(state.statusCode).toBe(200); expect(tvPowerStateSchema.parse(state.json())).toMatchObject({ mac: null, canPowerOff: true, canWake: false });
    expect(state.headers['cache-control']).toBe('no-store');
  }
  for (const [method, url, payload] of [
    ['POST', '/api/tv/power', off], ['POST', '/%61pi/tv/%70ower', off],
    ['PUT', '/api/tv/mac', { mac: null }], ['PUT', '/%61pi/tv/%6dac', { mac: null }],
    ['POST', `/api/tv/power/${id}/cancel`, {}], ['POST', `/%61pi/tv/%70ower/${id}/cancel`, {}],
  ] as const) {
    for (const [supplied, status] of [
      [{ origin }, 401], [{ cookie: headers.cookie, origin }, 403],
      [{ ...headers, origin: 'https://foreign.example.test' }, 403], [{ ...headers, 'x-csrf-token': 'invalid' }, 403],
    ] as const) {
      const response = await app.inject({ method, url, headers: supplied, payload });
      expect(response.statusCode).toBe(status); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().requestId).toBe(response.headers['x-request-id']);
    }
  }
  expect(h.adapters[0]!.powerOffs).toBe(0); expect(h.writes).toEqual([]);
});

test('strict power, MAC and cancel requests reject malformed input without effects', async () => {
  const { app, h, headers, post } = await fixture();
  for (const payload of [null, {}, { ...off, extra: true }, { id, action: 'power_off' }, { ...off, confirm: false }, { ...off, id: 'invalid' }, { ...wake, confirm: true }, { id, action: 'recover' }]) {
    const response = await post(payload); expect(response.statusCode).toBe(400); expect(response.headers['cache-control']).toBe('no-store');
  }
  for (const payload of [null, {}, { mac: null, extra: true }, { mac: 0 }, { mac: '' }, { mac: '01:00:00:00:00:01' }, { mac: '00:00:00:00:00:00' }]) {
    expect((await app.inject({ method: 'PUT', url: '/api/tv/mac', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) })).statusCode).toBe(400);
  }
  for (const payload of [null, [], { extra: true }]) expect((await app.inject({ method: 'POST', url: `/api/tv/power/${id}/cancel`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/tv/power/invalid/cancel', headers })).statusCode).toBe(400);
  expect(h.adapters[0]!.powerOffs).toBe(0); expect(h.writes).toEqual([]);
});

test('MAC update normalizes, clears and preserves the stored encrypted key', async () => {
  const { app, h, headers } = await fixture(false);
  const key = h.repository.load()!.encryptedClientKey;
  const set = await app.inject({ method: 'PUT', url: '/api/tv/mac', headers, payload: { mac: '02-ab-cd-ef-00-01' } });
  expect(set.statusCode).toBe(200); expect(tvPowerStateSchema.parse(set.json())).toMatchObject({ mac: '02:AB:CD:EF:00:01', canWake: true });
  expect(set.headers['cache-control']).toBe('no-store'); expect(h.repository.load()!.encryptedClientKey).toEqual(key);
  const clear = await app.inject({ method: 'PUT', url: '/api/tv/mac', headers, payload: { mac: null } });
  expect(clear.statusCode).toBe(200); expect(clear.json()).toMatchObject({ mac: null, canWake: false });
});

test('offline, missing MAC and unsupported capability are distinct admission failures', async () => {
  const offline = await fixture(false);
  expect((await offline.post()).statusCode).toBe(409);
  expect((await offline.post(wake)).json()).toMatchObject({ code: 'WOL_NOT_CONFIGURED' });
  const unsupported = await fixture(true, false);
  const response = await unsupported.post();
  expect(response.statusCode).toBe(422); expect(response.json()).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  expect(unsupported.h.adapters[0]!.powerOffs).toBe(0);
  const absent = await fixture(false, true, false);
  expect((await absent.app.inject({ method: 'PUT', url: '/api/tv/mac', headers: absent.headers, payload: { mac: null } })).statusCode).toBe(409);
});

test('power and existing control paths share the busy gate and foreign cancellation cannot use the UUID', async () => {
  const { app, h, headers, sessions, headersFor, post, cancel } = await fixture();
  h.adapters[0]!.readResult = barrier();
  const accepted = await post(); expect(accepted.statusCode).toBe(202);
  expect(tvPowerOperationSchema.parse(accepted.json())).toMatchObject({ id, status: 'running', action: 'power_off' });
  expect((await post({ ...off, id: otherId })).statusCode).toBe(409);
  expect((await app.inject({ method: 'PUT', url: '/api/tv/mac', headers, payload: { mac: null } })).statusCode).toBe(409);
  expect((await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'repair' } })).statusCode).toBe(409);
  expect((await app.inject({ method: 'POST', url: '/api/tv/commands', headers, payload: { id, button: 'HOME' } })).statusCode).toBe(409);
  const other = (await sessions.login('owner', 'synthetic password 123'))!;
  expect((await cancel(id, headersFor(other.token))).statusCode).toBe(403);
  expect(h.service.powerState().operation?.status).toBe('running');
  expect((await app.inject({ method: 'POST', url: `/api/tv/operations/${id}/cancel`, headers: headersFor(other.token) })).statusCode).toBe(404);
  expect((await cancel()).json()).toMatchObject({ id, status: 'cancelled', delivery: 'sent' });
  await drain(); expect(h.adapters[0]!.powerOffs).toBe(1);
});

test('same accepted UUID deduplicates across concurrent requests, after cancel and after a later operation', async () => {
  const { post, cancel, h } = await fixture(false); h.service.setMac('02:00:00:00:00:01');
  const replies = await Promise.all(Array.from({ length: 8 }, () => post(wake)));
  expect(replies.map((response) => response.statusCode)).toEqual(Array(8).fill(202));
  expect(replies.map((response) => response.json().id)).toEqual(Array(8).fill(id));
  expect(h.adapters.flatMap((adapter) => adapter.wakes)).toHaveLength(1);
  expect((await post(off)).statusCode).toBe(409);
  expect((await cancel()).json()).toMatchObject({ id, status: 'cancelled' }); await drain();
  expect((await post(wake)).json()).toMatchObject({ id, status: 'cancelled' });
  const next = { ...wake, id: otherId };
  expect((await post(next)).statusCode).toBe(202); await cancel(next.id); await drain();
  expect((await post(wake)).json()).toMatchObject({ id, status: 'cancelled' });
  expect(h.adapters.flatMap((adapter) => adapter.wakes)).toHaveLength(2);
});

test('power owner budget spans sessions and IPs, rejects do not charge, duplicates do not charge, and window expires', async () => {
  const { app, h, sessions, headersFor, headers, post, cancel } = await fixture(false);
  let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const other = (await sessions.login('owner', 'synthetic password 123'))!;
  for (let index = 0; index < 7; index++) { expect((await post()).statusCode).toBe(409); expect((await post({})).statusCode).toBe(400); expect((await post(wake)).statusCode).toBe(409); }
  h.service.setMac('02:00:00:00:00:01');
  for (let index = 0; index < 5; index++) {
    const payload = { ...wake, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` };
    const supplied = index % 2 ? headersFor(other.token) : headers;
    expect((await app.inject({ method: 'POST', url: '/api/tv/power', headers: supplied, remoteAddress: `203.0.113.${index + 1}`, payload })).statusCode).toBe(202);
    expect((await post(payload, supplied)).statusCode).toBe(202);
    expect((await post({ ...payload, id: otherId }, supplied)).statusCode).toBe(409);
    expect((await cancel(payload.id, supplied)).statusCode).toBe(200); await drain();
  }
  now += 59_001;
  const blocked = await post({ ...wake, id: otherId });
  expect(blocked.statusCode).toBe(429); expect(blocked.headers['retry-after']).toBe('1'); expect(blocked.headers['cache-control']).toBe('no-store');
  expect((await post(wake)).statusCode).toBe(202);
  // Existing setup and command buckets are independent of the power budget.
  expect((await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'reconnect' } })).statusCode).toBe(202);
  await h.service.cancelOwnedPower('unrelated');
  const reconnect = (await h.service.status()).operation!; h.service.cancel(reconnect.id); await drain();
  now += 999;
  const next = { ...wake, id: otherId }; expect((await post(next)).statusCode).toBe(202); await cancel(next.id);
});

test('receipt exhaustion rejects new UUIDs without evicting an accepted receipt or charging its duplicate', async () => {
  const { h, post, cancel } = await fixture(false); h.service.setMac('02:00:00:00:00:01');
  let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  for (let index = 0; index < 100; index++) {
    const payload = { ...wake, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` };
    expect((await post(payload)).statusCode).toBe(202); await cancel(payload.id); await drain(); now += 60_000;
  }
  const before = h.adapters.length;
  const denied = await post({ ...wake, id: otherId }); expect(denied.statusCode).toBe(409); expect(denied.json()).toMatchObject({ code: 'POWER_RECEIPT_CAPACITY' });
  expect((await post(wake)).json()).toMatchObject({ id, status: 'cancelled' }); expect(h.adapters).toHaveLength(before);
});

test.each(['logout', 'revoke'] as const)('%s cancels only the initiating session and waits for owned transport cleanup', async (ending) => {
  const { app, h, sessions, login, headers, headersFor, post, logs } = await fixture();
  const adapter = h.adapters[0]!; const send = barrier<void>(); const cleanup = barrier<void>();
  adapter.powerResult = send.promise; adapter.disconnectResult = cleanup.promise;
  let endingRequest: Promise<unknown> | undefined;
  try {
    expect((await post()).statusCode).toBe(202); expect(adapter.powerOffs).toBe(1);
    const other = (await sessions.login('owner', 'synthetic password 123'))!;
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headersFor(other.token) })).statusCode).toBe(204);
    expect(h.service.powerState().operation?.status).toBe('running');
    let ended = false;
    endingRequest = (ending === 'logout' ? app.inject({ method: 'POST', url: '/api/auth/logout', headers }) : Promise.resolve(sessions.revoke(login.token))).then((response) => { ended = true; return response; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sessions.authenticate(login.token)).toBeUndefined(); expect(h.service.powerState().operation).toMatchObject({ status: 'cancelled', delivery: 'unknown' });
    expect(ended).toBe(false); send.resolve(); await drain(); expect(ended).toBe(false); cleanup.resolve();
    const response = await endingRequest;
    if (ending === 'logout') expect(response).toMatchObject({ statusCode: 204 });
    expect((await app.inject({ url: '/api/tv/power', headers })).statusCode).toBe(401);
    expect(logs.join('')).not.toContain(login.token);
  } finally { send.resolve(); cleanup.resolve(); await endingRequest; }
});

test('legacy authenticated manual reconnect gains session ownership and logout waits for its cleanup', async () => {
  const { app, h, headers } = await fixture(false);
  expect((await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'reconnect' } })).statusCode).toBe(202);
  const adapter = h.adapters[0]!; const request = await adapter.enteredPair.promise; const cleanup = barrier<void>(); adapter.disconnectResult = cleanup.promise;
  let ended = false;
  const logout = app.inject({ method: 'POST', url: '/api/auth/logout', headers }).then((response) => { ended = true; return response; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve)); expect(request.signal.aborted).toBe(true); expect(ended).toBe(false);
    cleanup.resolve(); expect((await logout).statusCode).toBe(204); expect((await h.service.status()).operation?.status).toBe('cancelled');
  } finally { cleanup.resolve(); await logout; }
});

test.each(['revoke', 'lifecycle'] as const)('power admission rechecks %s after asynchronous limiter peek before effects or charging', async (change) => {
  const { app, h, login, sessions, post, headers } = await fixture();
  expect((await app.inject({ url: '/api/tv/power', headers })).statusCode).toBe(200);
  const entered = barrier<void>(); const release = barrier<void>(); const createLimiter = app.createRateLimit.bind(app); let charges = 0;
  vi.spyOn(app, 'createRateLimit').mockImplementation((options) => {
    const limiter = createLimiter(options);
    return async (request, callOptions) => {
      if (callOptions?.increment === false) { entered.resolve(); await release.promise; } else charges++;
      return limiter(request, callOptions);
    };
  });
  const pending = post(); await entered.promise;
  try {
    if (change === 'revoke') await sessions.revoke(login.token);
    else h.service.start({ action: 'repair' });
    release.resolve(); const response = await pending;
    expect(response.statusCode).toBe(change === 'revoke' ? 401 : 409); expect(charges).toBe(0); expect(h.adapters[0]!.powerOffs).toBe(0);
  } finally { release.resolve(); await pending; }
});

test('accepted transport failure stays asynchronous, safe and unknown without implicit resend', async () => {
  const { app, headers, h, post, logs } = await fixture();
  h.adapters[0]!.powerResult = Promise.reject(new TvPowerSendError('CONNECTION_LOST', 'unknown', 'synthetic-secret')); void h.adapters[0]!.powerResult.catch(() => {});
  const accepted = await post(); expect(accepted.statusCode).toBe(202); await drain();
  const state = await app.inject({ url: '/api/tv/power', headers });
  expect(state.json().operation).toMatchObject({ id, status: 'failed', delivery: 'unknown', error: { code: 'CONNECTION_LOST' } });
  expect((await post()).json()).toMatchObject({ id, status: 'failed', delivery: 'unknown' });
  expect(h.adapters[0]!.powerOffs).toBe(1); expect(state.body + logs.join('')).not.toMatch(/synthetic-secret|synthetic-key|clientKey/);
});

test('lost acceptance response retains the receipt before charge settles and a repeat never resends', async () => {
  const { app, h, post } = await fixture(); await app.ready();
  const createLimiter = app.createRateLimit.bind(app); let charges = 0;
  vi.spyOn(app, 'createRateLimit').mockImplementation((options) => {
    const limiter = createLimiter(options);
    return async (request, callOptions) => {
      if (callOptions?.increment !== false && charges++ === 0) throw new Error('synthetic charge failure');
      return limiter(request, callOptions);
    };
  });
  expect((await post()).statusCode).toBe(500);
  expect((await post()).statusCode).toBe(202); expect(charges).toBe(1); expect(h.adapters[0]!.powerOffs).toBe(1);
});

test('equal UUIDs accepted by different sessions retain separate receipts and cancellation authority', async () => {
  const { h, sessions, headersFor, post, cancel } = await fixture(false); h.service.setMac('02:00:00:00:00:01');
  const other = (await sessions.login('owner', 'synthetic password 123'))!; const foreign = headersFor(other.token);
  expect((await post(wake)).statusCode).toBe(202);
  expect((await post(wake, foreign)).statusCode).toBe(409);
  expect((await cancel()).statusCode).toBe(200); await drain();
  expect((await post(wake, foreign)).statusCode).toBe(202);
  expect((await post(wake)).json()).toMatchObject({ id, status: 'cancelled' });
  expect((await cancel()).json()).toMatchObject({ id, status: 'cancelled' });
  expect(h.service.powerState().operation?.status).toBe('running');
  expect((await cancel(id, foreign)).json()).toMatchObject({ id, status: 'cancelled' }); await drain();
  expect(h.adapters.flatMap((adapter) => adapter.wakes)).toHaveLength(2);
});

test('actual revocation invalidates immediately, invokes every listener and joins repeated cleanup despite failures', async () => {
  const { sessions, login } = await fixture(false);
  const cleanup = barrier<void>(); const firstFailure = new TypeError('synthetic first failure'); const secondFailure = new SyntaxError('synthetic second failure');
  let calls = 0; let lastInvoked = false;
  const removeFirst = sessions.onRevoke(() => { throw firstFailure; });
  const removeCleanup = sessions.onRevoke(async () => { calls++; await cleanup.promise; throw secondFailure; });
  const removeLast = sessions.onRevoke(() => { lastInvoked = true; });
  let pending: Promise<void> | undefined;
  try {
    pending = sessions.revoke(login.token);
    const settled = pending.catch((cause: unknown) => cause);
    expect(sessions.authenticate(login.token)).toBeUndefined(); expect(lastInvoked).toBe(true); expect(calls).toBe(1);
    expect(sessions.revoke(login.token)).toBe(pending); expect(calls).toBe(1);
    let ended = false; void settled.then(() => { ended = true; }); await drain(); expect(ended).toBe(false);
    cleanup.resolve(); const error = await settled;
    expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual([firstFailure, secondFailure]);
  } finally { cleanup.resolve(); removeFirst(); removeCleanup(); removeLast(); await pending?.catch(() => {}); }
});

test('MAC mutation rechecks the authenticated session after asynchronous request admission', async () => {
  const { app, h, headers, sessions, login } = await fixture(false);
  const entered = barrier<void>(); const release = barrier<void>();
  app.addHook('preHandler', async (request) => { if (request.routeOptions.url === '/api/tv/mac') { entered.resolve(); await release.promise; } });
  const pending = app.inject({ method: 'PUT', url: '/api/tv/mac', headers, payload: { mac: '02:00:00:00:00:01' } });
  await entered.promise;
  try {
    await sessions.revoke(login.token); release.resolve();
    expect((await pending).statusCode).toBe(401); expect(h.writes).toEqual([]);
  } finally { release.resolve(); await pending; }
});
