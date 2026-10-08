import { describe, expect, test } from 'vitest';
import { tvStatusResponseSchema } from '@remote-webos-tv/contracts';
import { Lgtv2Adapter, createLgtv2Client, createClientKeyCipher, WebOsError } from '@remote-webos-tv/webos';
import Database from 'better-sqlite3';
import { createTvService, type TvServiceDependencies } from '../src/tv/service.js';
import { projectTvError, TvServiceError } from '../src/tv/operation.js';
import { createTvRepository } from '../src/tv/repository.js';
import { tvConfigTableSql, schemaMigrations } from '../src/storage/migrations.js';
import { createStagingKeyStore } from '../src/tv/staging-key-store.js';
import { harness, succeed, drain, pairing, snapshot, barrier, ControlledScheduler } from './support/tv-harness.js';

describe('TV service persistence and projection', () => {
  test('buttonsWithoutPointerCanPrepareAndSend', async () => {
    const h = harness();
    try {
      h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
      const adapter = h.adapters[0]!;
      const events: string[] = [];
      Object.assign(adapter, { async prepareRemote() { events.push('prepared'); } });
      const send = adapter.sendButton.bind(adapter);
      adapter.sendButton = async (button, signal) => { events.push(button); await send(button, signal); };
      const capabilities = { ...pairing.capabilities, buttons: true, pointer: false };
      adapter.pairResult.resolve({ ...pairing, capabilities });
      await adapter.enteredRead.promise; adapter.readResult.resolve({ ...snapshot, capabilities }); await drain();
      expect(h.service.remoteState()).toEqual({ enabled: true, reason: null });
      expect(await h.service.sendCommand({ id: '00000000-0000-4000-8000-000000000001', button: 'UP' }, new AbortController().signal)).toEqual({ id: '00000000-0000-4000-8000-000000000001', outcome: 'sent' });
      expect(events).toEqual(['prepared', 'UP']);
    } finally { await h.service.close(); }
  });

  test('unsupportedButtonsSendNothing', async () => {
    const h = harness();
    try {
      h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
      const adapter = h.adapters[0]!;
      const events: string[] = [];
      Object.assign(adapter, { async prepareRemote() { events.push('prepared'); } });
      const capabilities = { ...pairing.capabilities, buttons: false, pointer: true };
      adapter.pairResult.resolve({ ...pairing, capabilities });
      await adapter.enteredRead.promise; adapter.readResult.resolve({ ...snapshot, capabilities }); await drain();
      expect(await h.service.sendCommand({ id: '00000000-0000-4000-8000-000000000001', button: 'UP' }, new AbortController().signal)).toMatchObject({ outcome: 'rejected', error: { code: 'UNSUPPORTED_CAPABILITY' } });
      expect(events).toEqual([]);
      expect(adapter.sent).toEqual([]);
    } finally { await h.service.close(); }
  });

  test('remote preparation failure sends no button and reports not sent', async () => {
    const h = harness();
    try {
      h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
      const adapter = h.adapters[0]!;
      Object.assign(adapter, { async prepareRemote() { throw new WebOsError('CONNECTION_LOST', 'synthetic preparation failure'); } });
      expect(await h.service.sendCommand({ id: '00000000-0000-4000-8000-000000000001', button: 'UP' }, new AbortController().signal)).toMatchObject({ outcome: 'rejected', error: { code: 'COMMAND_NOT_SENT' } });
      expect(adapter.sent).toEqual([]);
    } finally { await h.service.close(); }
  });

  test('optional app and power methods cannot advertise or perform unsupported work', async () => {
    const h = harness();
    try {
      h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
      const adapter = h.adapters[0]!;
      let launched = false;
      Object.assign(adapter, { listApps: undefined, powerOff: undefined, async launchApp() { launched = true; } });
      expect(await h.service.sendCommand({ id: '00000000-0000-4000-8000-000000000001', app: 'wink' }, new AbortController().signal)).toMatchObject({ outcome: 'rejected', error: { code: 'UNSUPPORTED_CAPABILITY' } });
      expect(launched).toBe(false);
      expect(h.service.powerState().canPowerOff).toBe(false);
    } finally { await h.service.close(); }
  });

  test('MAC discovery commits the first valid unicast address after snapshot succeeds', async () => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!;
    adapter.pairResult.resolve({ ...pairing, macAddresses: ['invalid', '01:00:00:00:00:01', '00:00:00:00:00:00', 'FF:FF:FF:FF:FF:FF', '02-ab-cd-ef-00-01', '02:00:00:00:00:02'] });
    await adapter.enteredRead.promise;
    expect(h.repository.load()).toBeNull();
    adapter.readResult.resolve(snapshot); await drain();
    expect(h.repository.load()?.macAddress).toBe('02:AB:CD:EF:00:01');
    const status = await h.service.status();
    expect(status.operation?.status).toBe('succeeded');
    expect(tvStatusResponseSchema.safeParse(status).success).toBe(true);
    expect(JSON.stringify(status)).not.toContain('macAddress');
    expect(JSON.stringify(status)).not.toContain('02:AB:CD:EF:00:01');
    await h.service.close();
  });

  test.each([{ macAddresses: [] }, { macAddresses: ['invalid', '01:00:00:00:00:01', 'FF:FF:FF:FF:FF:FF', '00:00:00:00:00:00'] }])('MAC discovery absence does not fail pairing: %j', async ({ macAddresses }) => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!; adapter.pairResult.resolve({ ...pairing, macAddresses });
    await adapter.enteredRead.promise; adapter.readResult.resolve(snapshot); await drain();
    expect(h.repository.load()?.macAddress).toBeNull();
    expect((await h.service.status()).operation?.status).toBe('succeeded');
    await h.service.close();
  });

  test.each(['reconnect', 'repair'] as const)('MAC saved manually survives %s and registered key replacement', async (action) => {
    const base = harness(true);
    base.repository.replace({ ...base.repository.load()!, macAddress: '02:AB:CD:EF:00:01' });
    const h = harness(true, { repository: base.repository });
    h.service.start({ action }); await drain();
    const adapter = h.adapters[0]!;
    adapter.pairResult.resolve({ ...pairing, credential: 'synthetic-new-key', macAddresses: ['02:00:00:00:00:02'] });
    await adapter.enteredRead.promise; adapter.readResult.resolve(snapshot); await drain();
    expect(base.repository.load()?.macAddress).toBe('02:AB:CD:EF:00:01');
    expect(h.cipher.decrypt(base.repository.load()!.encryptedCredential)).toBe('synthetic-new-key');
    await h.service.close(); await base.service.close();
  });

  test.each([{ macAddresses: ['02:00:00:00:00:02'], expected: '02:00:00:00:00:02' }, { macAddresses: [], expected: null }])('MAC change_address discards the old physical address even when model matches: %j', async ({ macAddresses, expected }) => {
    const base = harness(true); base.repository.replace({ ...base.repository.load()!, macAddress: '02:AB:CD:EF:00:01' });
    const h = harness(true, { repository: base.repository });
    h.service.start({ action: 'change_address', host: '192.168.1.11' }); await drain();
    const adapter = h.adapters[0]!; adapter.pairResult.resolve({ ...pairing, macAddresses });
    await adapter.enteredRead.promise; adapter.readResult.resolve(snapshot); await drain();
    expect(base.repository.load()?.macAddress).toBe(expected);
    await h.service.close(); await base.service.close();
  });

  test('MAC changed identity cannot retain the old address on reconnect', async () => {
    const base = harness(true); base.repository.replace({ ...base.repository.load()!, macAddress: '02:AB:CD:EF:00:01' });
    const h = harness(true, { repository: base.repository });
    h.service.start({ action: 'reconnect' }); await drain();
    const adapter = h.adapters[0]!;
    adapter.pairResult.resolve({ ...pairing, identity: { model: 'Synthetic Replacement' }, macAddresses: [] });
    await adapter.enteredRead.promise; adapter.readResult.resolve(snapshot); await drain();
    expect(base.repository.load()?.macAddress).toBeNull();
    await h.service.close(); await base.service.close();
  });

  test.each(['synthetic-key', 'synthetic-replacement-key'])('MAC cleared to null survives ordinary reconnect with registered key %s', async (clientKey) => {
    const base = harness(true);
    base.repository.replace({ ...base.repository.load()!, macAddress: '02:AB:CD:EF:00:01' });
    base.repository.replace({ ...base.repository.load()!, macAddress: null });
    const key = base.repository.load()!.encryptedCredential;
    const h = harness(true, { repository: base.repository });
    try {
      h.service.start({ action: 'reconnect' }); await drain();
      const adapter = h.adapters[0]!;
      adapter.pairResult.resolve({ ...pairing, credential: clientKey, macAddresses: ['02:00:00:00:00:02'] });
      await adapter.enteredRead.promise; adapter.readResult.resolve(snapshot); await drain();
      expect(base.repository.load()?.macAddress).toBeNull();
      expect((await h.service.status()).operation?.status).toBe('succeeded');
      expect(h.cipher.decrypt(base.repository.load()!.encryptedCredential)).toBe(clientKey);
      if (clientKey === 'synthetic-key') {
        expect(base.repository.load()?.encryptedCredential).toEqual(key);
        expect(base.writes).toHaveLength(2);
      }
    } finally { await h.service.close(); await base.service.close(); }
  });

  test('MAC absent in saved configuration can be discovered during explicit repair', async () => {
    const h = harness(true);
    try {
      h.service.start({ action: 'repair' }); await drain();
      const adapter = h.adapters[0]!;
      adapter.pairResult.resolve({ ...pairing, macAddresses: ['02:00:00:00:00:02'] });
      await adapter.enteredRead.promise; adapter.readResult.resolve(snapshot); await drain();
      expect(h.repository.load()?.macAddress).toBe('02:00:00:00:00:02');
      expect((await h.service.status()).operation?.status).toBe('succeeded');
    } finally { await h.service.close(); }
  });
  test('all ten browser commands reach mock-TV through the current real adapter once', async () => {
    const fixture = await protocolFixture('success'); const service = createTvService(fixture.dependencies);
    const id = '15e082b2-de7e-4d86-a049-19c7448264f1'; const signal = new AbortController().signal;
    try {
      service.start({ action: 'pair', host: '192.168.1.10' }); await fixture.committed.promise; await drain();
      for (const button of ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'HOME', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE'] as const) {
        expect(await service.sendCommand({ id, button }, signal)).toEqual({ id, outcome: 'sent' });
      }
      await fixture.mock.waitForPointerFrameCount(10);
      expect(fixture.mock.pointerFrames).toEqual([
        'type:button\nname:UP\n\n', 'type:button\nname:DOWN\n\n', 'type:button\nname:LEFT\n\n', 'type:button\nname:RIGHT\n\n', 'type:button\nname:ENTER\n\n',
        'type:button\nname:BACK\n\n', 'type:button\nname:HOME\n\n', 'type:button\nname:VOLUMEUP\n\n', 'type:button\nname:VOLUMEDOWN\n\n', 'type:button\nname:MUTE\n\n',
      ]);
      expect(fixture.mock.pairingPromptCount).toBe(1);
    } finally { await service.close(); await fixture.mock.stop(); fixture.sql.close(); }
  });

  test('safe projection terminates on cyclic and deeply nested error causes', () => {
    const cyclic = new WebOsError('NETWORK_UNREACHABLE', 'private cyclic detail'); cyclic.cause = cyclic;
    let deep: Error = new TvServiceError('CLEANUP_FAILED');
    for (let index = 0; index < 20_000; index++) deep = new Error('private deep detail', { cause: deep });
    expect(projectTvError(cyclic).code).toBe('NETWORK_UNREACHABLE');
    expect(projectTvError(deep).code).toBe('TV_OPERATION_FAILED');
    expect(projectTvError(new WebOsError('NETWORK_UNREACHABLE', 'private', { cause: new TvServiceError('CLEANUP_FAILED') })).code).toBe('NETWORK_UNREACHABLE_CLEANUP_FAILED');
  });

  test('cyclic adapter failure still produces a terminal safe operation response', async () => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const cause = new WebOsError('NETWORK_UNREACHABLE', 'private cyclic detail'); cause.cause = cause;
    h.adapters[0]!.pairResult.reject(cause); await drain();
    const status = await h.service.status();
    expect(status.operation).toMatchObject({ status: 'failed', error: { code: 'NETWORK_UNREACHABLE' } });
    expect(JSON.stringify(status)).not.toContain('private cyclic detail'); await h.service.close();
  });
  test('commits encrypted TV only after registration and safe snapshot succeed', async () => {
    const h = harness();
    const operation = h.service.start({ action: 'pair', host: '192.168.1.10' });
    expect(operation).toMatchObject({ id: 'operation-1', status: 'running', startedAt: 1_000_000, deadlineAt: 1_060_000 });
    await drain();
    const adapter = h.adapters[0]!;
    await adapter.staging.save(pairing.credential);
    adapter.pairResult.resolve(pairing);
    await adapter.enteredRead.promise;
    expect(h.repository.load()).toBeNull();
    adapter.readResult.resolve(snapshot);
    await drain();
    const status = await h.service.status();
    expect(status).toMatchObject({ tv: { host: '192.168.1.10', identity: { model: 'Synthetic Model' } }, connection: 'available', operation: { status: 'succeeded' } });
    expect(h.cipher.decrypt(h.repository.load()!.encryptedCredential)).toBe('synthetic-key');
    expect(h.writes).toHaveLength(1);
    expect(tvStatusResponseSchema.safeParse(status).success).toBe(true);
    expect(JSON.stringify(status)).not.toContain('synthetic-key');
    expect(JSON.stringify(status)).not.toContain('encryptedCredential');
    await h.service.close();
  });

  test.each([
    ['PAIRING_REJECTED', 'authorization_error'],
    ['NETWORK_UNREACHABLE', 'unavailable'],
    ['INVALID_TV_RESPONSE', 'compatibility_error'],
    ['UNSUPPORTED_CAPABILITY', 'compatibility_error'],
  ] as const)('keeps permanent storage empty on %s after staging save', async (code, connection) => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!; await adapter.staging.save('synthetic-key');
    adapter.pairResult.reject(new WebOsError(code, 'raw private detail'));
    await drain();
    const status = await h.service.status();
    expect(status).toMatchObject({ tv: null, connection, operation: { status: 'failed', error: { code } } });
    expect(h.writes).toEqual([]); expect(adapter.closed).toBe(true);
    expect(JSON.stringify(status)).not.toContain('raw private detail'); await h.service.close();
  });

  test('rejects registered result without a credential', async () => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    h.adapters[0]!.pairResult.resolve({ ...pairing, credential: '' }); await drain();
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'INVALID_TV_RESPONSE' } });
    expect(h.writes).toEqual([]); await h.service.close();
  });

  test('does not commit after readSnapshot fails following registration', async () => {
    const h = harness(); h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!; await adapter.staging.save('synthetic-key'); adapter.pairResult.resolve(pairing);
    await adapter.enteredRead.promise; adapter.readResult.reject(new WebOsError('CONNECTION_LOST', 'private'));
    await drain(); expect(h.repository.load()).toBeNull();
    expect((await h.service.status()).connection).toBe('unavailable'); await h.service.close();
  });

  test('staging clear never clears another operation key', async () => {
    const first = createStagingKeyStore('first-synthetic'); const second = createStagingKeyStore();
    await second.save('second-synthetic'); await first.clear();
    expect(await first.load()).toBeUndefined(); expect(await second.load()).toBe('second-synthetic');
  });

  test('maps invalid action, unknown cancel and concurrent start to safe HTTP errors', async () => {
    const h = harness();
    expect(() => h.service.start({ action: 'repair' })).toThrowError(expect.objectContaining({ statusCode: 409 }));
    expect(() => h.service.cancel('unknown')).toThrowError(expect.objectContaining({ statusCode: 404 }));
    h.service.start({ action: 'pair', host: '192.168.1.10' });
    expect(() => h.service.start({ action: 'pair', host: '192.168.1.11' })).toThrowError(expect.objectContaining({ statusCode: 409 }));
    await drain(); expect(h.adapters).toHaveLength(1); await h.service.close();
  });

  test('successful commit makes a later cancel an unchanged success', async () => {
    const h = harness(); const operation = h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    await succeed(h.adapters[0]!);
    expect(h.service.cancel(operation.id).status).toBe('succeeded'); expect(h.writes).toHaveLength(1); await h.service.close();
  });

  test('real mock-TV pair survives service restart and saved registration needs no new PROMPT', async () => {
    const fixture = await protocolFixture('success');
    let service = createTvService(fixture.dependencies);
    try {
      service.start({ action: 'pair', host: '192.168.1.10' }); await fixture.committed.promise; await drain();
      expect((await service.status()).connection).toBe('available');
      expect(fixture.mock.pairingPromptCount).toBe(1);
      expect(fixture.cipher.decrypt(fixture.repository.load()!.encryptedCredential)).toBe('synthetic-mock-client-key');
      expect(fixture.repository.load()?.macAddress).toBe('02:00:00:00:00:01');
      await service.close(); fixture.resetRead();
      service = createTvService(fixture.dependencies); await service.initialize(); await fixture.readFinished.promise; await drain();
      expect((await service.status()).connection).toBe('available'); expect(fixture.mock.pairingPromptCount).toBe(1);
      expect(fixture.repository.load()?.macAddress).toBe('02:00:00:00:00:01');
      expect(fixture.sql.prepare('SELECT count(*) AS count FROM tv_devices').get()).toEqual({ count: 1 });
    } finally { await service.close(); await fixture.mock.stop(); fixture.sql.close(); }
  });

  test('real mock-TV identity failure after saveKey never commits SQLite', async () => {
    const fixture = await protocolFixture('identity-loss'); const service = createTvService(fixture.dependencies);
    try {
      service.start({ action: 'pair', host: '192.168.1.10' }); await fixture.staged.promise;
      await fixture.cleaned.promise; await drain();
      expect(fixture.repository.load()).toBeNull();
      expect((await service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'CONNECTION_LOST' } });
    } finally { await service.close(); await fixture.mock.stop(); fixture.sql.close(); }
  });

  test('a failed permanent write preserves saved TV and exposes only its safe cause', async () => {
    const h = harness(true); const original = h.repository.load();
    h.repository.replace = () => { throw new Error('private SQLite path'); };
    h.service.start({ action: 'change_address', host: '192.168.1.11' }); await drain(); await succeed(h.adapters[0]!);
    expect(h.repository.load()).toEqual(original);
    const status = await h.service.status();
    expect(status.operation).toMatchObject({ status: 'failed', error: { code: 'STORAGE_FAILED' } });
    expect(JSON.stringify(status)).not.toContain('private SQLite path'); await h.service.close();
  });

  test('encryption failure after registration cannot replace an existing setup', async () => {
    const base = harness(true); const original = base.repository.load();
    const h = harness(true, { repository: base.repository, cipher: { ...base.cipher, encrypt() { throw new Error('private cipher detail'); } } });
    h.service.start({ action: 'repair' }); await drain(); await succeed(h.adapters[0]!);
    expect(base.repository.load()).toEqual(original);
    expect((await h.service.status()).operation).toMatchObject({ status: 'failed', error: { code: 'KEY_STORE_WRITE_FAILED' } });
    await h.service.close(); await base.service.close();
  });
});

async function protocolFixture(scenario: 'success' | 'identity-loss') {
  // Deliberately test-only dynamic import: the protocol fixture is not in API production output.
  const { MockWebOsTv } = await import(new URL('../../../packages/webos/test/support/mock-webos-tv.js', import.meta.url).href);
  const mock = new MockWebOsTv({ scenario: scenario === 'success' ? { kind: 'success' } : { kind: 'close-before-response', uri: 'ssap://system/getSystemInfo' } });
  await mock.start();
  const sql = new Database(':memory:'); sql.exec(tvConfigTableSql);
  schemaMigrations[2]!.up(sql);
  schemaMigrations[3]!.up(sql);
  schemaMigrations[4]!.up(sql);
  const repository = createTvRepository(sql);
  const cipher = createClientKeyCipher(Buffer.alloc(32, 7));
  const committed = barrier<void>(); const staged = barrier<void>();
  const cleaned = barrier<void>();
  let readFinished = barrier<void>();
  let id = 0;
  const dependencies: TvServiceDependencies = {
    repository: { ...repository, replace(value) { repository.replace(value); committed.resolve(); } }, cipher,
    scheduler: new ControlledScheduler(), now: () => 1_000_000, newId: () => `mock-operation-${++id}`,
    createAdapter(host, staging, requestTimeoutMs, allowPairingPrompt) {
      const adapter = new Lgtv2Adapter({ host, keyStore: { ...staging, async save(key) { await staging.save(key); staged.resolve(); } }, requestTimeoutMs, allowPairingPrompt, handshakeTimeoutMs: 500, now: () => new Date(1_000_000) }, {
        createClient(options) {
          const port = Number(new URL(mock.url).port);
          return createLgtv2Client({ ...options, host: '127.0.0.1', ports: { secure: port, insecure: port }, verifyCert: false });
        },
      });
      const readSnapshot = adapter.readSnapshot.bind(adapter);
      adapter.readSnapshot = async (signal) => { const value = await readSnapshot(signal); readFinished.resolve(); return value; };
      const disconnect = adapter.disconnect.bind(adapter);
      adapter.disconnect = async () => { await disconnect(); cleaned.resolve(); };
      return adapter;
    },
  };
  return { mock, sql, repository, cipher, committed, staged, cleaned, dependencies, get readFinished() { return readFinished; }, resetRead() { readFinished = barrier<void>(); } };
}
