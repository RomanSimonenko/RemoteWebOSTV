import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { tvCommandResultSchema } from '@remote-webos-tv/contracts';
import { TvButtonSendError } from '@remote-webos-tv/webos';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/storage/database.js';
import { createOwnerRepository } from '../src/auth/repository.js';
import { createOwnerSetupService } from '../src/auth/service.js';
import { createAuthSessionService } from '../src/auth/sessions.js';
import { barrier, drain, harness, pairing, snapshot } from './support/tv-harness.js';

const origin = 'https://remote.example.test';
const command = { id: '00000000-0000-4000-8000-000000000001', button: 'HOME' as const };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(ready = true, pointer = true) {
  const directory = await mkdtemp(join(tmpdir(), 'tv-command-routes-'));
  const database = await openDatabase({ dataDir: directory });
  const repository = createOwnerRepository(database.sqlite);
  const setup = createOwnerSetupService({ repository });
  const token = await setup.issueSetupToken();
  await setup.claimOwner({ token, username: 'owner', password: 'synthetic password 123' });
  const sessions = await createAuthSessionService({ repository, masterKey: Buffer.alloc(32, 7) });
  const login = (await sessions.login('owner', 'synthetic password 123'))!;
  const headersFor = (sessionToken: string) => ({ cookie: `remote_webos_session=${sessionToken}`, origin, 'x-csrf-token': sessions.authenticate(sessionToken)!.csrfToken });
  const logs: string[] = [];
  const h = harness();
  if (ready) {
    h.service.start({ action: 'pair', host: '192.168.1.10' });
    await drain();
    const adapter = h.adapters[0]!;
    adapter.pairResult.resolve({ ...pairing, capabilities: { ...pairing.capabilities, pointer } });
    await adapter.enteredRead.promise;
    adapter.readResult.resolve({ ...snapshot, capabilities: { ...snapshot.capabilities, pointer } });
    await drain();
  }
  const app = buildApp({
    config: { dataDir: directory, host: '127.0.0.1', port: 0, publicOrigin: origin, secureCookies: true, trustedProxy: [] },
    getSetupState: async () => repository.getSetupState(), auth: { setup, sessions }, tv: h.service,
    logStream: new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } }),
  });
  cleanups.push(async () => { await app.close(); await h.service.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = headersFor(login.token);
  const post = (payload: unknown = command, supplied = headers) => app.inject({ method: 'POST', url: '/api/tv/commands', headers: { ...supplied, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  return { app, h, logs, headers, headersFor, sessions, login, post };
}

test('remote and command routes enforce session, Origin, CSRF and no-store including encoded aliases', async () => {
  const { app, h, headers } = await fixture();
  for (const url of ['/api/tv/remote', '/%61pi/tv/%72emote']) {
    const denied = await app.inject(url);
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['cache-control']).toBe('no-store');
    const state = await app.inject({ url, headers });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual({ enabled: true, reason: null });
    expect(state.headers['cache-control']).toBe('no-store');
  }
  for (const url of ['/api/tv/commands', '/%61pi/tv/%63ommands']) {
    for (const [supplied, status] of [
      [{ origin }, 401], [{ cookie: headers.cookie, origin }, 403],
      [{ ...headers, origin: 'https://foreign.example.test' }, 403], [{ ...headers, 'x-csrf-token': 'invalid' }, 403],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, headers: supplied, payload: command });
      expect(response.statusCode).toBe(status);
      expect(response.json().requestId).toBe(response.headers['x-request-id']);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  }
  expect(h.adapters[0]!.sent).toEqual([]);
});

test('strict command schema keeps existing requestId errors, no-store and does not send', async () => {
  const { post, h } = await fixture();
  for (const payload of [{ ...command, extra: true }, { ...command, button: 'EXIT' }, { ...command, id: 'invalid' }, { button: 'UP' }, null]) {
    const response = await post(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'BAD_REQUEST', message: 'Bad request', requestId: response.headers['x-request-id'] });
    expect(response.headers['cache-control']).toBe('no-store');
  }
  expect(h.adapters[0]!.sent).toEqual([]);
});

test('all twenty buttons send once across two windows; owner budget spans source addresses and sessions and expires at 1000ms', async () => {
  const { app, h, headers, sessions, headersFor } = await fixture();
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const other = (await sessions.login('owner', 'synthetic password 123'))!;
  const buttons = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'HOME', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  for (const [index, button] of buttons.entries()) {
    if (index === 10) now += 1000;
    const response = await app.inject({ method: 'POST', url: '/api/tv/commands', headers: index % 2 ? headersFor(other.token) : headers, remoteAddress: `203.0.113.${index + 1}`, payload: { ...command, button } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: command.id, outcome: 'sent' });
    expect(response.headers['cache-control']).toBe('no-store');
  }
  now += 999;
  const blocked = await app.inject({ method: 'POST', url: '/api/tv/commands', headers, payload: command });
  expect(blocked.statusCode).toBe(429);
  expect(blocked.headers['retry-after']).toBe('1');
  expect(tvCommandResultSchema.parse(blocked.json())).toMatchObject({ id: command.id, outcome: 'rejected', error: { code: 'RATE_LIMITED' } });
  expect(blocked.headers['cache-control']).toBe('no-store');
  expect(h.adapters[0]!.sent).toEqual(buttons);
  now += 1;
  expect((await app.inject({ method: 'POST', url: '/api/tv/commands', headers, payload: command })).statusCode).toBe(200);
});

test('offline, malformed and busy rejections do not spend accepted command budget; pairing has a separate bucket', async () => {
  const { app, h, headers, post } = await fixture(false);
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  for (let index = 0; index < 12; index++) {
    const response = await post();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ id: command.id, outcome: 'rejected', error: { code: 'TV_UNAVAILABLE' } });
    expect((await post({ ...command, extra: true })).statusCode).toBe(400);
  }
  const pair = await app.inject({ method: 'POST', url: '/api/tv/operations', headers, payload: { action: 'pair', host: '192.168.1.10' } });
  expect(pair.statusCode).toBe(202);
  await drain();
  const adapter = h.adapters[0]!;
  for (let index = 0; index < 12; index++) expect((await post()).json()).toMatchObject({ outcome: 'rejected', error: { code: 'TV_BUSY' } });
  adapter.pairResult.resolve(pairing);
  await adapter.enteredRead.promise;
  adapter.readResult.resolve(snapshot);
  await drain();
  for (let index = 0; index < 10; index++) expect((await post()).statusCode).toBe(200);
  expect((await post()).statusCode).toBe(429);
});

test('unsupported commands use 422, remain safe and do not enter the adapter', async () => {
  const { app, headers, post, h } = await fixture(true, false);
  expect((await app.inject({ url: '/api/tv/remote', headers })).json()).toEqual({ enabled: false, reason: 'UNSUPPORTED' });
  const response = await post();
  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ id: command.id, outcome: 'rejected', error: { code: 'UNSUPPORTED_CAPABILITY' } });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(h.adapters[0]!.sent).toEqual([]);
});

test('concurrent request is rejected promptly while the first command is pending, without a command queue', async () => {
  const { app, headers, post, h } = await fixture();
  expect((await app.inject({ url: '/api/tv/remote', headers })).statusCode).toBe(200);
  const gate = barrier<void>();
  const adapter = h.adapters[0]!;
  adapter.sendResult = gate.promise;
  const first = post();
  await adapter.enteredSend.promise;
  try {
    const second = await post({ ...command, id: '00000000-0000-4000-8000-000000000002' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ outcome: 'rejected', error: { code: 'TV_BUSY' } });
    expect(adapter.sent).toEqual(['HOME']);
  } finally { gate.resolve(); await first; }
});

test('command delivery errors map to 503/504 and preserve safe command ids and messages', async () => {
  const { post, h, logs } = await fixture();
  const adapter = h.adapters[0]!;
  adapter.sendResult = Promise.reject(new TvButtonSendError('CONNECTION_LOST', 'not_sent', 'synthetic-secret'));
  void adapter.sendResult.catch(() => {});
  const notSent = await post();
  expect(notSent.statusCode).toBe(503);
  expect(tvCommandResultSchema.parse(notSent.json())).toMatchObject({ id: command.id, outcome: 'rejected', error: { code: 'COMMAND_NOT_SENT' } });
  adapter.sendResult = Promise.reject(new Error('synthetic-secret'));
  void adapter.sendResult.catch(() => {});
  const unknown = await post();
  expect(unknown.statusCode).toBe(504);
  expect(tvCommandResultSchema.parse(unknown.json())).toMatchObject({ id: command.id, outcome: 'unknown', error: { code: 'COMMAND_RESULT_UNKNOWN' } });
  expect(notSent.headers['cache-control']).toBe('no-store');
  expect(unknown.headers['cache-control']).toBe('no-store');
  expect(notSent.body + unknown.body + logs.join('')).not.toMatch(/synthetic-secret|192\.168\.1\.10|clientKey/);
});

test.each(['logout', 'revoke'] as const)('%s aborts only commands owned by that session through the actual auth service', async (ending) => {
  const { app, headers, headersFor, sessions, login, post, h, logs } = await fixture();
  expect((await app.inject({ url: '/api/tv/remote', headers })).statusCode).toBe(200);
  const gate = barrier<void>();
  const adapter = h.adapters[0]!;
  adapter.sendResult = gate.promise;
  const pending = post();
  const signal = await adapter.enteredSend.promise;
  try {
    const other = (await sessions.login('owner', 'synthetic password 123'))!;
    expect(signal.aborted).toBe(false);
    const foreignLogout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headersFor(other.token) });
    expect(foreignLogout.statusCode).toBe(204);
    expect(signal.aborted).toBe(false);
    if (ending === 'logout') expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode).toBe(204);
    else await sessions.revoke(login.token);
    expect(signal.aborted).toBe(true);
    const response = await pending;
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ id: command.id, outcome: 'unknown' });
    expect(response.body + logs.join('')).not.toContain(login.token);
  } finally { gate.resolve(); await pending; }
});

test('request abort preserves unknown delivery and normal request close does not cancel a command', async () => {
  const { app, headers, post, h } = await fixture();
  let request!: FastifyRequest;
  app.addHook('onRequest', async (current) => { if (current.routeOptions.url === '/api/tv/commands') request = current; });
  expect((await app.inject({ url: '/api/tv/remote', headers })).statusCode).toBe(200);
  const adapter = h.adapters[0]!;
  const gate = barrier<void>();
  adapter.sendResult = gate.promise;
  const pending = post();
  const signal = await adapter.enteredSend.promise;
  try {
    request.raw.emit('close');
    expect(signal.aborted).toBe(false);
    request.raw.emit('aborted');
    expect(signal.aborted).toBe(true);
    const response = await pending;
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ outcome: 'unknown' });
  } finally { gate.resolve(); await pending; }
});

test.each(['revoke', 'lifecycle', 'disconnect'] as const)('admission rechecks %s after limiter peek yields and does not charge or send', async (change) => {
  const { app, h, login, sessions, post } = await fixture();
  let reply!: FastifyReply;
  app.addHook('onRequest', async (_request, current) => { reply = current; });
  await app.ready();
  const entered = barrier<void>();
  const release = barrier<void>();
  const createLimiter = app.createRateLimit.bind(app);
  let charges = 0;
  vi.spyOn(app, 'createRateLimit').mockImplementation((options) => {
    const limiter = createLimiter(options);
    return async (request, callOptions) => {
      if (callOptions?.increment === false) { entered.resolve(); await release.promise; }
      else charges++;
      return limiter(request, callOptions);
    };
  });
  const pending = post();
  const settled = pending.then((response) => ({ response }), (error: unknown) => ({ error }));
  await entered.promise;
  try {
    if (change === 'revoke') await sessions.revoke(login.token);
    if (change === 'lifecycle') h.service.start({ action: 'reconnect' });
    if (change === 'disconnect') reply.raw.emit('close');
    release.resolve();
    const result = await settled;
    if (change === 'disconnect') {
      expect('error' in result && result.error).toBeInstanceOf(Error);
    } else {
      if (!('response' in result)) throw result.error;
      expect(result.response.statusCode).toBe(change === 'revoke' ? 401 : 409);
      if (change === 'revoke') expect(result.response.json().code).toBe('UNAUTHORIZED');
      else expect(result.response.json()).toMatchObject({ id: command.id, outcome: 'rejected', error: { code: 'TV_BUSY' } });
    }
    expect(h.adapters[0]!.sent).toEqual([]);
    expect(charges).toBe(0);
  } finally { release.resolve(); await settled; }
});

test('premature response close cancels pending work while completed response close leaves sent result intact', async () => {
  const { app, h, post } = await fixture();
  let reply!: FastifyReply;
  app.addHook('onRequest', async (_request, current) => { reply = current; });
  const gate = barrier<void>();
  const adapter = h.adapters[0]!;
  adapter.sendResult = gate.promise;
  const pending = post();
  const settled = pending.catch((cause: unknown) => cause);
  const signal = await adapter.enteredSend.promise;
  try {
    reply.raw.emit('close');
    expect(signal.aborted).toBe(true);
    expect(await settled).toBeInstanceOf(Error);
  } finally { gate.resolve(); await settled; await drain(); }
  adapter.sendResult = Promise.resolve();
  const response = await post();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ id: command.id, outcome: 'sent' });
  reply.raw.emit('close');
  expect(h.service.remoteState()).toEqual({ enabled: true, reason: null });
});

test('real HTTP body completion permits a command, while disconnect during admission prevents late sending', async () => {
  const { app, h, headers } = await fixture();
  const disconnected = barrier<void>();
  const handled = barrier<void>();
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers['x-test-disconnect']) reply.raw.once('close', () => disconnected.resolve());
  });
  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.headers['x-test-disconnect']) handled.resolve();
    return payload;
  });
  await app.ready();
  const entered = barrier<void>();
  const release = barrier<void>();
  let pause = false;
  let charges = 0;
  const createLimiter = app.createRateLimit.bind(app);
  vi.spyOn(app, 'createRateLimit').mockImplementation((options) => {
    const limiter = createLimiter(options);
    return async (request, callOptions) => {
      if (pause && callOptions?.increment === false) { entered.resolve(); await release.promise; }
      if (callOptions?.increment !== false) charges++;
      return limiter(request, callOptions);
    };
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const send = (disconnect = false) => {
    let client!: ReturnType<typeof httpRequest>;
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      client = httpRequest(`${address}/api/tv/commands`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...(disconnect ? { 'x-test-disconnect': 'true' } : {}) } }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      });
      client.on('error', reject);
      client.end(JSON.stringify(command));
    });
    return { client, result };
  };
  const normal = await send().result;
  expect(normal).toEqual({ status: 200, body: JSON.stringify({ id: command.id, outcome: 'sent' }) });
  pause = true;
  const abandoned = send(true);
  const failure = abandoned.result.catch((cause: unknown) => cause);
  try {
    await entered.promise;
    const reason = new Error('synthetic client disconnect');
    abandoned.client.destroy(reason);
    expect(await failure).toBe(reason);
    await disconnected.promise;
    release.resolve();
    await handled.promise;
    expect(h.adapters[0]!.sent).toEqual(['HOME']);
    expect(charges).toBe(1);
  } finally { abandoned.client.destroy(); release.resolve(); await failure; }
});

test('Wink uses the protected command route and missing app returns a validated 422 result', async () => {
  const { post, h, headers } = await fixture(); const launched: string[] = [];
  Object.assign(h.adapters[0]!, { listApps: async () => [{ id: 'synthetic.wink', name: 'Wink' }, { id: 'synthetic.dev', name: 'Wink Dev' }], launchApp: async (id: string) => { launched.push(id); } });
  const input = { id: command.id, app: 'wink' };
  expect((await post(input, { ...headers, 'x-csrf-token': 'invalid' })).statusCode).toBe(403);
  expect(launched).toEqual([]);
  const result = await post(input);
  expect(result.statusCode).toBe(200); expect(tvCommandResultSchema.parse(result.json())).toEqual({ id: input.id, outcome: 'sent' });
  expect(result.headers['cache-control']).toBe('no-store'); expect(launched).toEqual(['synthetic.wink']);
  Object.assign(h.adapters[0]!, { listApps: async () => [] });
  const missing = await post({ ...input, id: '00000000-0000-4000-8000-000000000002' });
  expect(missing.statusCode).toBe(422); expect(tvCommandResultSchema.parse(missing.json())).toMatchObject({ outcome: 'rejected', error: { code: 'APP_NOT_AVAILABLE' } });
  expect(launched).toEqual(['synthetic.wink']);
});
