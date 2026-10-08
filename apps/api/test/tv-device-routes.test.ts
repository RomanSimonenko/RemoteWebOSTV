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
import { platformTransports } from './support/platform-transports.js';
import { Writable } from 'node:stream';

const origin = 'https://remote.example.test';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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
async function fixture(realTransports = false) {
  const directory = await mkdtemp(join(tmpdir(), 'multi-tv-routes-')); const db = await openDatabase({ dataDir: directory });
  const owner = createOwnerRepository(db.sqlite); const setup = createOwnerSetupService({ repository: owner });
  const token = await setup.issueSetupToken(); await setup.claimOwner({ token, username: 'owner', password: 'synthetic password 123' });
  const sessions = await createAuthSessionService({ repository: owner, masterKey: Buffer.alloc(32, 7) });
  const login = (await sessions.login('owner', 'synthetic password 123'))!;
  const headers = { cookie: `remote_webos_session=${login.token}`, origin, 'x-csrf-token': sessions.authenticate(login.token)!.csrfToken };
  const scheduler = new ControlledScheduler(); const adapters: ControlledAdapter[] = []; let next = 1;
  const transports = realTransports ? await platformTransports(scheduler) : undefined;
  const finished = new Map<string, ReturnType<typeof barrier<void>>>();
  const terminal = (operationId: string) => { let gate = finished.get(operationId); if (!gate) { gate = barrier<void>(); finished.set(operationId, gate); } return gate; };
  const repository = createTvDeviceRepository(db.sqlite);
  const cipher = createClientKeyCipher(Buffer.alloc(32, 7));
  const createRegistry = () => createTvDeviceRegistry({ repository, scheduler, newId: () => id(next++), createService: (repository, onOperationFinished, platform) => createTvService({ repository, platform, onOperationFinished(operation) { onOperationFinished(operation); terminal(operation.id).resolve(); }, scheduler, cipher, now: () => scheduler.now(), newId: () => id(next++), createAdapter: transports?.createAdapter ?? ((_host, staging) => { const adapter = new ControlledAdapter(staging); adapters.push(adapter); return adapter; }) }) });
  const registry = createRegistry();
  const unsubscribe = sessions.onRevoke(token => registry.revoke(token, !sessions.hasActiveSessions()));
  const app = buildApp({ logStream: new Writable({ write(_chunk, _encoding, done) { done(); } }), config: { dataDir: directory, host: '127.0.0.1', port: 0, publicOrigin: origin, secureCookies: true, trustedProxy: [] }, getSetupState: async () => owner.getSetupState(), auth: { setup, sessions }, tv: registry.legacy(), tvs: registry });
  cleanups.push(async () => { unsubscribe(); await app.close(); await registry.close(); await transports?.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  async function add(n: number, host: string, platform: 'webos' | 'tizen' = 'webos') {
    const response = await app.inject({ method: 'POST', url: '/api/tvs', headers, payload: { id: id(n), platform, host } });
    expect(response.statusCode).toBe(202);
    if (transports) { if (platform === 'tizen') await transports.finishSamsung(); await terminal(response.json().operation.id).promise; await drain(); }
    else { await drain(); await succeed(adapters.at(-1)!); }
    return response.json().tvId as string;
  }
  return { app, headers, adapters, add, registry, createRegistry, repository, sessions, cipher, scheduler, transports: transports!, waitFinished: (operationId: string) => terminal(operationId).promise, token: login.token };
}

test('final logout releases watched services so later sessions do not revisit disposed owners', async () => {
  const h = await fixture(); const tvId = await h.add(100, '10.2.3.4');
  const oldService = h.registry.get(tvId)!;
  const oldCancellation = vi.spyOn(oldService, 'cancelOwnedPower');
  expect((await h.app.inject({ url: `/api/tvs/${tvId}/power`, headers: h.headers })).statusCode).toBe(200);
  const other = (await h.sessions.login('owner', 'synthetic password 123'))!;
  const headersFor = (token: string) => ({ cookie: `remote_webos_session=${token}`, origin, 'x-csrf-token': h.sessions.authenticate(token)!.csrfToken });
  expect((await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: headersFor(other.token) })).statusCode).toBe(204);
  expect(oldCancellation).toHaveBeenCalledTimes(2); // Registry and watched power receiver.
  expect(h.registry.get(tvId)).toBe(oldService);
  expect((await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: h.headers })).statusCode).toBe(204);
  expect(oldCancellation).toHaveBeenCalledTimes(3);
  const fresh = h.registry.get(tvId)!; expect(fresh).not.toBe(oldService);
  const freshCancellation = vi.spyOn(fresh, 'cancelOwnedPower');
  const next = (await h.sessions.login('owner', 'synthetic password 123'))!;
  const nextHeaders = headersFor(next.token);
  expect((await h.app.inject({ url: `/api/tvs/${tvId}/power`, headers: nextHeaders })).statusCode).toBe(200);
  expect((await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: nextHeaders })).statusCode).toBe(204);
  expect(freshCancellation).toHaveBeenCalledTimes(1);
  expect(oldCancellation).toHaveBeenCalledTimes(3);
  expect(h.repository.list().map(tv => tv.tvId)).toEqual([tvId]);
});

test('lgAndSamsungRemainConnectedWhenSelectionChanges', async () => {
  const h = await fixture(true); const lg = await h.add(100, '10.2.3.4'); const samsung = await h.add(101, '10.2.3.5', 'tizen');
  for (const tvId of [lg, samsung, lg, samsung]) {
    expect((await h.app.inject({ url: `/api/tvs/${tvId}/remote`, headers: h.headers })).json()).toEqual({ enabled: true, reason: null, apps: tvId === lg });
    expect((await h.app.inject({ url: `/api/tvs/${tvId}`, headers: h.headers })).json().connection).toBe('available');
  }
  expect(h.transports.lg.activeSocketCount).toBe(1); expect(h.transports.sockets[0]!.terminateCount).toBe(0);
  expect(h.repository.list()).toEqual([{ tvId: lg, platform: 'webos' }, { tvId: samsung, platform: 'tizen' }]);
});

test('sameRequestIdIsIndependentAcrossPlatforms', async () => {
  const h = await fixture(true); const lg = await h.add(100, '10.2.3.4'); const samsung = await h.add(101, '10.2.3.5', 'tizen');
  for (const [tvId, button] of [[lg, 'UP'], [samsung, 'DOWN'], [lg, 'LEFT'], [samsung, 'RIGHT']]) {
    const response = await h.app.inject({ method: 'POST', url: `/api/tvs/${tvId}/commands`, headers: h.headers, payload: { id: id(200), button } });
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  }
  await h.transports.lg.waitForPointerFrameCount(2);
  expect(h.transports.lg.pointerFrames).toEqual(['type:button\nname:UP\n\n', 'type:button\nname:LEFT\n\n']);
  expect(h.transports.sockets[0]!.frames.map(frame => JSON.parse(frame).params.DataOfCmd)).toEqual(['KEY_DOWN', 'KEY_RIGHT']);
});

test('unknownTvNeverTargetsDefault', async () => {
  const h = await fixture(true); await h.add(100, '10.2.3.4'); await h.add(101, '10.2.3.5', 'tizen');
  for (const [suffix, payload] of [['commands', { id: id(200), button: 'UP' }], ['operations', { action: 'reconnect' }], ['power', { id: id(201), action: 'wake' }]] as const) {
    const response = await h.app.inject({ method: 'POST', url: `/api/tvs/${id(900)}/${suffix}`, headers: h.headers, payload });
    expect(response.statusCode).toBe(404); expect(response.headers['cache-control']).toBe('no-store');
  }
  expect(h.transports.lg.pointerFrames).toEqual([]); expect(h.transports.sockets[0]!.frames).toEqual([]); expect(h.transports.sockets).toHaveLength(1);
});

test('deleteSamsungLeavesLgConnected', async () => {
  const h = await fixture(true); const lg = await h.add(100, '10.2.3.4'); const samsung = await h.add(101, '10.2.3.5', 'tizen');
  expect((await h.app.inject({ method: 'DELETE', url: `/api/tvs/${samsung}`, headers: h.headers, payload: { confirm: true } })).statusCode).toBe(204);
  expect(h.transports.sockets[0]!.terminateCount).toBe(1); expect(h.transports.sockets[0]!.listenerCount).toBe(0);
  expect((await h.registry.get(lg)!.status()).connection).toBe('available'); expect(h.transports.lg.activeSocketCount).toBe(1);
  expect(h.repository.list()).toEqual([{ tvId: lg, platform: 'webos' }]);
});

test.each(['paired', 'restarted', 'recreated'] as const)('logoutClosesBothTransports: %s', async (lifecycle) => {
  const h = await fixture(true); const lg = await h.add(100, '10.2.3.4'); const samsung = await h.add(101, '10.2.3.5', 'tizen');
  const before = h.repository.list().map(({ tvId }) => h.repository.forDevice(tvId).load());
  let registry = h.registry;
  if (lifecycle === 'restarted') {
    await registry.close(); registry = h.createRegistry();
    const unsubscribe = h.sessions.onRevoke(token => registry.revoke(token, !h.sessions.hasActiveSessions()));
    cleanups.push(async () => { unsubscribe(); await registry.close(); });
    await registry.initialize();
    const operation = (await registry.get(lg)!.status()).operation!;
    await h.waitFinished(operation.id); await h.transports.finishSamsung(); await drain();
  } else if (lifecycle === 'recreated') {
    vi.spyOn(h.repository, 'remove').mockImplementationOnce(() => { throw new Error('Synthetic storage failure'); });
    await expect(registry.remove(samsung, () => {})).rejects.toThrow('Synthetic storage failure');
    const operation = registry.get(samsung)!.start({ action: 'reconnect' });
    await h.transports.finishSamsung(); await h.waitFinished(operation.id); await drain();
  }
  const response = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: h.headers }); expect(response.statusCode).toBe(204);
  expect(h.transports.sockets.every(socket => socket.terminateCount === 1 && socket.listenerCount === 0)).toBe(true);
  await h.transports.lg.waitForActiveSocketCount(0);
  expect(h.repository.list().map(({ tvId }) => h.repository.forDevice(tvId).load())).toEqual(before);
  expect(h.repository.legacyId()).toBe(lg); expect(h.repository.list().map(tv => tv.tvId)).toEqual([lg, samsung]);
});

test('logoutOneSessionKeepsAnotherSessionAndItsSamsungWork', async () => {
  const h = await fixture(true); const lg = await h.add(100, '10.2.3.4'); const samsung = await h.add(101, '10.2.3.5', 'tizen');
  const other = (await h.sessions.login('owner', 'synthetic password 123'))!;
  const otherHeaders = { ...h.headers, cookie: `remote_webos_session=${other.token}`, 'x-csrf-token': h.sessions.authenticate(other.token)!.csrfToken };
  const pending = await h.app.inject({ method: 'POST', url: `/api/tvs/${samsung}/operations`, headers: otherHeaders, payload: { action: 'reconnect' } }); expect(pending.statusCode).toBe(202);
  expect((await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: h.headers })).statusCode).toBe(204);
  expect(h.sessions.authenticate(other.token)).toBeDefined(); expect(h.transports.lg.activeSocketCount).toBe(1);
  await h.transports.finishSamsung(); await h.waitFinished(pending.json().id); await drain();
  expect(h.transports.sockets[1]!.terminateCount).toBe(0);
  expect((await h.registry.get(lg)!.status()).connection).toBe('available'); expect((await h.registry.get(samsung)!.status()).connection).toBe('available');
});

test('failedSamsungPairLeavesLgCredentialsIntact', async () => {
  const h = await fixture(true); const lg = await h.add(100, '10.2.3.4'); const before = h.repository.forDevice(lg).load();
  const response = await h.app.inject({ method: 'POST', url: '/api/tvs', headers: h.headers, payload: { id: id(101), platform: 'tizen', host: '10.2.3.5' } }); expect(response.statusCode).toBe(202);
  await h.transports.finishSamsung(false); await h.waitFinished(response.json().operation.id); await drain();
  expect(h.repository.forDevice(lg).load()).toEqual(before); expect(h.repository.list()).toEqual([{ tvId: lg, platform: 'webos' }]);
  expect(h.transports.sockets[0]!.terminateCount).toBe(1); expect(h.transports.sockets[0]!.listenerCount).toBe(0);
  expect((await h.registry.get(lg)!.status()).connection).toBe('available');
  const failure = await h.app.inject({ url: `/api/tvs/${response.json().tvId}`, headers: h.headers });
  expect(failure.json().operation).toMatchObject({ status: 'failed', error: { code: 'PAIRING_REJECTED' } }); expect(failure.body).not.toMatch(/token|encryptedCredential|10\.2\.3\.5/);
});

test('SamsungReconnectPreservesStableIdCredentialMacOrderAndDefault', async () => {
  const h = await fixture(true); const lg = await h.add(100, '10.2.3.4'); const samsung = await h.add(101, '10.2.3.5', 'tizen');
  h.registry.get(samsung)!.setMac('02:00:00:00:00:02');
  const before = h.repository.forDevice(samsung).load();
  const response = await h.app.inject({ method: 'POST', url: `/api/tvs/${samsung}/operations`, headers: h.headers, payload: { action: 'reconnect' } }); expect(response.statusCode).toBe(202);
  await h.transports.finishSamsung(); await h.waitFinished(response.json().id); await drain();
  expect(h.repository.forDevice(samsung).load()).toEqual(before);
  expect(h.cipher.decrypt(before!.encryptedCredential)).toBe('synthetic-token');
  expect(new URL(h.transports.urls[1]!).searchParams.get('token')).toBe('synthetic-token');
  expect(h.repository.list()).toEqual([{ tvId: lg, platform: 'webos' }, { tvId: samsung, platform: 'tizen' }]); expect(h.repository.legacyId()).toBe(lg);
  expect(h.transports.sockets[0]!.terminateCount).toBe(1); expect(h.transports.sockets[1]!.terminateCount).toBe(0);
});

test('revoked Samsung authorization stops recovery without retry or a pairing prompt', async () => {
  const h = await fixture(true); const lg = await h.add(100, '10.2.3.4'); const samsung = await h.add(101, '10.2.3.5', 'tizen');
  const before = h.repository.forDevice(samsung).load();
  const response = await h.app.inject({ method: 'POST', url: `/api/tvs/${samsung}/operations`, headers: h.headers, payload: { action: 'reconnect' } }); expect(response.statusCode).toBe(202);
  await h.transports.finishSamsung(false); await h.waitFinished(response.json().id); await drain();
  h.scheduler.advance(300_000); await drain();
  const status = (await h.app.inject({ url: `/api/tvs/${samsung}`, headers: h.headers })).json();
  expect(status).toMatchObject({ connection: 'authorization_error', operation: { status: 'failed', error: { code: 'AUTHORIZATION_FAILED' } } });
  expect(h.transports.sockets).toHaveLength(2); expect(new URL(h.transports.urls[1]!).searchParams.get('token')).toBe('synthetic-token');
  expect(h.transports.sockets[1]!.terminateCount).toBe(1); expect(h.transports.sockets[1]!.listenerCount).toBe(0);
  expect(h.repository.forDevice(samsung).load()).toEqual(before); expect((await h.registry.get(lg)!.status()).connection).toBe('available');
});

test('Samsung mutation paths retain authentication Origin CSRF and no-store policy', async () => {
  const h = await fixture(true); await h.add(100, '10.2.3.4'); const samsung = await h.add(101, '10.2.3.5', 'tizen');
  const url = `/api/tvs/${samsung}`; const before = h.repository.forDevice(samsung).load();
  const mutations = [
    { method: 'POST', url: '/api/tvs', payload: { id: id(102), platform: 'tizen', host: '10.2.3.6' } },
    { method: 'POST', url: `${url}/commands`, payload: { id: id(200), button: 'UP' } },
    { method: 'POST', url: `${url}/operations`, payload: { action: 'repair' } },
    { method: 'POST', url: `${url}/operations/${id(200)}/cancel`, payload: {} },
    { method: 'POST', url: `${url}/power`, payload: { id: id(200), action: 'wake' } },
    { method: 'POST', url: `${url}/power/${id(200)}/cancel`, payload: {} },
    { method: 'PUT', url: `${url}/mac`, payload: { mac: '02:00:00:00:00:02' } },
    { method: 'DELETE', url, payload: { confirm: true } },
  ] as const;
  for (const mutation of mutations) {
    for (const [headers, expected] of [[{ origin }, 401], [{ ...h.headers, origin: 'https://foreign.example.test' }, 403], [{ ...h.headers, 'x-csrf-token': 'wrong' }, 403]] as const) {
      const response = await h.app.inject({ ...mutation, headers });
      expect(response.statusCode).toBe(expected); expect(response.headers['cache-control']).toBe('no-store');
    }
  }
  for (const suffix of ['', '/remote', '/power']) {
    const response = await h.app.inject(`${url}${suffix}`); expect(response.statusCode).toBe(401); expect(response.headers['cache-control']).toBe('no-store');
  }
  for (const payload of [{ id: id(200), app: 'wink' }, { id: id(201), action: 'power_off', confirm: true }, { id: id(202), action: 'wake' }]) {
    const response = await h.app.inject({ method: 'POST', url: `${url}/${'app' in payload ? 'commands' : 'power'}`, headers: h.headers, payload });
    expect(response.statusCode).toBe(422); expect(response.json().error?.code ?? response.json().code).toBe('UNSUPPORTED_CAPABILITY'); expect(response.headers['cache-control']).toBe('no-store');
  }
  expect(h.repository.forDevice(samsung).load()).toEqual(before); expect(h.transports.sockets).toHaveLength(1);
  expect(h.transports.sockets[0]!.frames).toEqual([]); expect(h.transports.sockets[0]!.terminateCount).toBe(0); expect(h.transports.lg.pointerFrames).toEqual([]);
});

test('LG and Samsung share the command and setup attempt limits', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const h = await fixture(true); const lg = await h.add(100, '10.2.3.4'); const samsung = await h.add(101, '10.2.3.5', 'tizen');
  for (let index = 0; index < 10; index++) {
    const response = await h.app.inject({ method: 'POST', url: `/api/tvs/${index % 2 ? samsung : lg}/commands`, headers: h.headers, payload: { id: id(200 + index), button: 'UP' } }); expect(response.statusCode).toBe(200);
  }
  for (const tvId of [samsung, lg]) {
    const response = await h.app.inject({ method: 'POST', url: `/api/tvs/${tvId}/commands`, headers: h.headers, payload: { id: id(300), button: 'DOWN' } });
    expect(response.statusCode).toBe(429); expect(response.json().error.code).toBe('RATE_LIMITED'); expect(response.headers['cache-control']).toBe('no-store');
  }
  await h.transports.lg.waitForPointerFrameCount(5); expect(h.transports.lg.pointerFrames).toHaveLength(5); expect(h.transports.sockets[0]!.frames).toHaveLength(5);
  for (let index = 0; index < 3; index++) {
    const response = await h.app.inject({ method: 'POST', url: '/api/tvs', headers: h.headers, payload: { id: id(400 + index), platform: 'tizen', host: `10.2.3.${6 + index}` } }); expect(response.statusCode).toBe(202);
    await h.transports.finishSamsung(false); await h.waitFinished(response.json().operation.id); await drain();
  }
  const limited = await h.app.inject({ method: 'POST', url: '/api/tvs', headers: h.headers, payload: { id: id(500), platform: 'tizen', host: '10.2.3.9' } });
  expect(limited.statusCode).toBe(429); expect(limited.headers['cache-control']).toBe('no-store'); expect(h.transports.sockets).toHaveLength(4);
  const replay = await h.app.inject({ method: 'POST', url: '/api/tvs', headers: h.headers, payload: { id: id(101), platform: 'tizen', host: '10.2.3.5' } }); expect(replay.statusCode).toBe(202); expect(replay.json().tvId).toBe(samsung);
});

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
