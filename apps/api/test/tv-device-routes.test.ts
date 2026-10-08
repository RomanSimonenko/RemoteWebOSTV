import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createClientKeyCipher } from '@remote-webos-tv/webos';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/storage/database.js';
import { createOwnerRepository } from '../src/auth/repository.js';
import { createOwnerSetupService } from '../src/auth/service.js';
import { createAuthSessionService } from '../src/auth/sessions.js';
import { createTvDeviceRepository } from '../src/tv/repository.js';
import { createTvDeviceRegistry } from '../src/tv/device-registry.js';
import { createTvService } from '../src/tv/service.js';
import { barrier, ControlledAdapter, ControlledScheduler, drain, succeed } from './support/tv-harness.js';

const origin = 'https://remote.example.test';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('Tizen addition cannot use the webOS factory before platform routing is installed', async () => {
  const h = await fixture();
  const response = await h.app.inject({ method: 'POST', url: '/api/tvs', headers: h.headers, payload: { id: id(100), platform: 'tizen', host: '10.2.3.4' } });
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe('UNSUPPORTED_CAPABILITY');
  expect(h.adapters).toEqual([]);
  expect(h.repository.list()).toEqual([]);
});

test('confirmed deletion removes only the addressed TV and protects the mutation', async () => {
  const h = await fixture(); const first = await h.add(100, '10.2.3.4'); const second = await h.add(101, '10.2.3.5');
  const url = `/api/tvs/${first}`;
  expect((await h.app.inject({ method: 'DELETE', url, headers: { origin }, payload: { confirm: true } })).statusCode).toBe(401);
  expect((await h.app.inject({ method: 'DELETE', url, headers: { ...h.headers, 'x-csrf-token': 'wrong' }, payload: { confirm: true } })).statusCode).toBe(403);
  expect((await h.app.inject({ method: 'DELETE', url, headers: h.headers, payload: { confirm: false } })).statusCode).toBe(400);
  expect((await h.app.inject({ method: 'DELETE', url, headers: h.headers })).statusCode).toBe(400);
  expect((await h.app.inject({ method: 'DELETE', url, headers: { ...h.headers, origin: 'https://foreign.example.test' }, payload: { confirm: true } })).statusCode).toBe(403);
  expect((await h.app.inject({ method: 'DELETE', url, headers: h.headers, payload: { confirm: true } })).statusCode).toBe(204);
  expect((await h.app.inject({ method: 'DELETE', url, headers: h.headers, payload: { confirm: true } })).statusCode).toBe(204);
  expect((await h.app.inject({ url, headers: h.headers })).statusCode).toBe(404);
  expect((await h.registry.list()).map(tv => tv.tvId)).toEqual([second]);
  expect(h.registry.legacy()).toBe(h.registry.get(second));
  expect(h.adapters[0]!.closed).toBe(true);
  expect(h.adapters.map(adapter => adapter.powerOffs)).toEqual([0, 0]);
  expect((await h.app.inject({ method: 'POST', url: '/api/tvs', headers: h.headers, payload: { id: id(100), platform: 'webos', host: '10.2.3.4' } })).statusCode).toBe(404);
});

test('deletion waits for transport cleanup and rechecks the session before deleting storage', async () => {
  const h = await fixture(); const tvId = await h.add(100, '10.2.3.4');
  const cleanup = barrier<void>(); h.adapters[0]!.disconnectResult = cleanup.promise;
  const pending = h.app.inject({ method: 'DELETE', url: `/api/tvs/${tvId}`, headers: h.headers, payload: { confirm: true } });
  // Starting the injection owns the request; the adapter exposes the exact close boundary.
  const responsePromise = pending.then(response => response);
  await h.adapters[0]!.enteredDisconnect.promise;
  expect(h.registry.get(tvId)).toBeNull();
  const revoking = h.sessions.revoke(h.token);
  cleanup.resolve(); await revoking;
  expect((await responsePromise).statusCode).toBe(401);
  expect((await h.registry.list()).map(tv => tv.tvId)).toEqual([tvId]);
});
test('power receipts survive service recreation after a failed deletion', async () => {
  const h = await fixture(); const tvId = await h.add(100, '10.2.3.4');
  const payload = { id: id(200), action: 'power_off', confirm: true };
  const accepted = await h.app.inject({ method: 'POST', url: `/api/tvs/${tvId}/power`, headers: h.headers, payload });
  expect(accepted.statusCode).toBe(202); await drain();
  const oldService = h.registry.get(tvId);
  vi.spyOn(h.repository, 'remove').mockImplementationOnce(() => { throw new Error('Synthetic storage failure'); });
  const failed = await h.app.inject({ method: 'DELETE', url: `/api/tvs/${tvId}`, headers: h.headers, payload: { confirm: true } });
  expect(failed.statusCode).toBe(500);
  expect(h.registry.get(tvId)).not.toBe(oldService);
  const replay = await h.app.inject({ method: 'POST', url: `/api/tvs/${tvId}/power`, headers: h.headers, payload });
  expect(replay.statusCode).toBe(202);
  expect(replay.json().id).toBe(payload.id);
  expect(h.adapters.map(adapter => adapter.powerOffs)).toEqual([1]);
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'multi-tv-routes-')); const db = await openDatabase({ dataDir: directory });
  const owner = createOwnerRepository(db.sqlite); const setup = createOwnerSetupService({ repository: owner });
  const token = await setup.issueSetupToken(); await setup.claimOwner({ token, username: 'owner', password: 'synthetic password 123' });
  const sessions = await createAuthSessionService({ repository: owner, masterKey: Buffer.alloc(32, 7) });
  const login = (await sessions.login('owner', 'synthetic password 123'))!;
  const headers = { cookie: `remote_webos_session=${login.token}`, origin, 'x-csrf-token': sessions.authenticate(login.token)!.csrfToken };
  const scheduler = new ControlledScheduler(); const adapters: ControlledAdapter[] = []; let next = 1;
  const repository = createTvDeviceRepository(db.sqlite);
  const registry = createTvDeviceRegistry({ repository, scheduler, newId: () => id(next++), createService: (repository, onOperationFinished) => createTvService({ repository, onOperationFinished, scheduler, cipher: createClientKeyCipher(Buffer.alloc(32, 7)), now: () => scheduler.now(), newId: () => id(next++), createAdapter(_host, staging) { const adapter = new ControlledAdapter(staging); adapters.push(adapter); return adapter; } }) });
  const app = buildApp({ config: { dataDir: directory, host: '127.0.0.1', port: 0, publicOrigin: origin, secureCookies: true, trustedProxy: [] }, getSetupState: async () => owner.getSetupState(), auth: { setup, sessions }, tv: registry.legacy(), tvs: registry });
  cleanups.push(async () => { await app.close(); await registry.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  async function add(n: number, host: string) {
    const response = await app.inject({ method: 'POST', url: '/api/tvs', headers, payload: { id: id(n), platform: 'webos', host } });
    expect(response.statusCode).toBe(202); await drain(); await succeed(adapters.at(-1)!); return response.json().tvId as string;
  }
  return { app, headers, adapters, add, registry, repository, sessions, token: login.token };
}

test('commandsReachOnlyAddressedAdapterAndLegacyRemainsOnOriginalTv', async () => {
  const h = await fixture(); const first = await h.add(100, '10.2.3.4'); const second = await h.add(101, '10.2.3.5');
  const command = async (url: string, button: string) => h.app.inject({ method: 'POST', url, headers: h.headers, payload: { id: id(200), button } });
  expect((await command(`/api/tvs/${first}/commands`, 'UP')).statusCode).toBe(200);
  expect((await command(`/api/tvs/${second}/commands`, 'DOWN')).statusCode).toBe(200);
  expect((await command('/api/tv/commands', 'UP')).statusCode).toBe(200);
  expect(h.adapters[0]!.sent).toEqual(['UP', 'UP']); expect(h.adapters[1]!.sent).toEqual(['DOWN']);
  expect((await h.app.inject({ url: '/api/tvs', headers: h.headers })).json().devices.map((tv: { tvId: string }) => tv.tvId)).toEqual([first, second]);
});

test('unknownIdNeverUsesDefaultAndEncodedPathsCannotBypassPolicy', async () => {
  const h = await fixture(); const first = await h.add(100, '10.2.3.4');
  for (const path of ['/api/tvs', `/api/tvs/${first}`, `/api/tvs/${first}/remote`, `/api/tvs/${first}/power`, `/%61pi/tvs/${first}/%72emote`]) {
    const response = await h.app.inject(path); expect(response.statusCode).toBe(401); expect(response.headers['cache-control']).toBe('no-store');
  }
  expect((await h.app.inject({ url: `/api/tvs/${id(900)}`, headers: h.headers })).statusCode).toBe(404);
  expect((await h.app.inject({ url: '/api/tvs/invalid', headers: h.headers })).statusCode).toBe(400);
  for (const path of ['/api/tvs', `/api/tvs/${first}/commands`, `/api/tvs/${first}/power`, `/api/tvs/${first}/operations`]) {
    expect((await h.app.inject({ method: 'POST', url: path, payload: {} })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: path, headers: { ...h.headers, origin: 'https://foreign.example.test' }, payload: {} })).statusCode).toBe(403);
  }
  expect(h.adapters[0]!.sent).toEqual([]);
});

test('samePowerRequestIdIsIndependentAcrossTvsAndCannotCancelOtherDevice', async () => {
  const h = await fixture(); const first = await h.add(100, '10.2.3.4'); const second = await h.add(101, '10.2.3.5');
  expect((await h.app.inject({ method: 'POST', url: `/api/tvs/${second}/power/${id(200)}/cancel`, headers: h.headers })).statusCode).toBe(403);
  for (const tvId of [first, second]) {
    const result = await h.app.inject({ method: 'POST', url: `/api/tvs/${tvId}/power`, headers: h.headers, payload: { id: id(200), action: 'power_off', confirm: true } }); expect(result.statusCode).toBe(202);
  }
  await drain(); expect(h.adapters.map((adapter) => adapter.powerOffs)).toEqual([1, 1]);
});

test('logoutDuringAdmissionSendsNothingOnAddressedDevice', async () => {
  const h = await fixture(); const first = await h.add(100, '10.2.3.4'); await h.app.ready();
  const entered = barrier<void>(); const release = barrier<void>(); const createLimiter = h.app.createRateLimit.bind(h.app);
  vi.spyOn(h.app, 'createRateLimit').mockImplementation((options) => {
    const limiter = createLimiter(options);
    return async (request, callOptions) => { if (callOptions?.increment === false) { entered.resolve(); await release.promise; } return limiter(request, callOptions); };
  });
  const pending = h.app.inject({ method: 'POST', url: `/api/tvs/${first}/commands`, headers: h.headers, payload: { id: id(200), button: 'UP' } }).then((response) => response);
  await entered.promise;
  try { await h.sessions.revoke(h.token); release.resolve(); expect((await pending).statusCode).toBe(401); expect(h.adapters[0]!.sent).toEqual([]); }
  finally { release.resolve(); await pending; }
});

test('addReplaySurvivesExhaustedAttemptBudgetWithoutReprompting', async () => {
  const h = await fixture(); const payload = { id: id(100), platform: 'webos', host: '10.2.3.4' };
  const accepted = await h.app.inject({ method: 'POST', url: '/api/tvs', headers: h.headers, payload }); expect(accepted.statusCode).toBe(202);
  for (let index = 0; index < 5; index++) {
    const replay = await h.app.inject({ method: 'POST', url: '/api/tvs', headers: h.headers, payload }); expect(replay.statusCode).toBe(202); expect(replay.json().tvId).toBe(accepted.json().tvId);
  }
  await drain(); expect(h.adapters).toHaveLength(1);
});

test('replayingAddDoesNotPairTwiceAndDuplicateHostConflicts', async () => {
  const h = await fixture(); const payload = { id: id(100), platform: 'webos', host: '10.2.3.4' };
  const first = await h.app.inject({ method: 'POST', url: '/api/tvs', headers: h.headers, payload });
  expect(first.statusCode).toBe(202);
  const replay = await h.app.inject({ method: 'POST', url: '/api/tvs', headers: h.headers, payload }); expect(replay.json().tvId).toBe(first.json().tvId);
  expect((await h.app.inject({ method: 'POST', url: '/api/tvs', headers: h.headers, payload: { ...payload, id: id(101) } })).statusCode).toBe(409);
  await drain(); expect(h.adapters).toHaveLength(1);
});
