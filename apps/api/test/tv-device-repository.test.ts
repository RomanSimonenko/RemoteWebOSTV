import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadClientKeyCipher } from '@remote-webos-tv/webos';
import { afterEach, expect, test } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import { schemaMigrations } from '../src/storage/migrations.js';
import * as repositories from '../src/tv/repository.js';

const directories: string[] = [];
async function directory() { const value = await mkdtemp(join(tmpdir(), 'multi-tv-')); directories.push(value); return value; }
afterEach(async () => { for (const value of directories.splice(0)) await rm(value, { recursive: true, force: true }); });
const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const tv: repositories.StoredTv = { platform: 'webos', host: '10.2.3.4', identity: { model: 'Synthetic LG', platformVersion: '6.5' }, macAddress: '02:AB:CD:EF:00:01', encryptedCredential: { version: 1 as const, algorithm: 'aes-256-gcm' as const, iv: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.from('synthetic').toString('base64'), authTag: Buffer.alloc(16, 2).toString('base64') } };

test('migrationPreservesLgAuthorizationAndDefault', async () => {
  const dataDir = await directory();
  const cipher = await loadClientKeyCipher({ directory: dataDir, hasStoredKey: false });
  const envelope = JSON.stringify(cipher.encrypt('synthetic-lg-key'), null, 1);
  const old = new Database(join(dataDir, 'app.sqlite'));
  for (const migration of schemaMigrations.slice(0, 4)) { migration.up(old); old.prepare('INSERT INTO migration_version VALUES (?, 1)').run(migration.version); }
  const insert = old.prepare("INSERT INTO tv_devices (position, tv_id, platform, host, identity_json, encrypted_client_key_json, mac_address) VALUES (?, ?, 'webos', ?, ?, ?, ?)");
  insert.run(3, first, tv.host, JSON.stringify(tv.identity), envelope, tv.macAddress);
  insert.run(8, second, '10.2.3.5', JSON.stringify(tv.identity), envelope, null);
  insert.run(12, '00000000-0000-4000-8000-000000000003', '10.2.3.6', JSON.stringify(tv.identity), envelope, null);
  old.prepare('DELETE FROM tv_devices WHERE position = 12').run();
  old.prepare('INSERT INTO tv_default VALUES (1, ?)').run(second);
  old.close();
  const db = await openDatabase({ dataDir });
  try {
    const repo = repositories.createTvDeviceRepository(db.sqlite);
    const saved = repo.forDevice(first).load()!;
    expect(saved).toMatchObject({ platform: 'webos', encryptedCredential: JSON.parse(envelope), macAddress: tv.macAddress });
    const restoredCipher = await loadClientKeyCipher({ directory: dataDir, hasStoredKey: true });
    expect(restoredCipher.decrypt(saved.encryptedCredential)).toBe('synthetic-lg-key');
    expect(repo.legacyId()).toBe(second);
    expect(db.sqlite.prepare('SELECT position, tv_id FROM tv_devices ORDER BY position').all()).toEqual([{ position: 3, tv_id: first }, { position: 8, tv_id: second }]);
    expect(db.sqlite.prepare('SELECT encrypted_credential_json FROM tv_devices WHERE tv_id = ?').get(first)).toEqual({ encrypted_credential_json: envelope });
    expect(repositories.createTvRepository(db.sqlite).load()?.host).toBe('10.2.3.5');
    const backups = await readdir(join(dataDir, 'backups'));
    expect(backups).toHaveLength(1);
    const backupPath = join(dataDir, 'backups', backups[0]!);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(backup.prepare('SELECT max(version) AS version FROM migration_version').get()).toEqual({ version: 4 });
      expect(backup.prepare('SELECT encrypted_client_key_json FROM tv_devices WHERE tv_id = ?').get(first)).toEqual({ encrypted_client_key_json: envelope });
      expect(backup.prepare('SELECT tv_id FROM tv_default').get()).toEqual({ tv_id: second });
    } finally { backup.close(); }
    repo.forDevice('00000000-0000-4000-8000-000000000003').replace({ ...tv, host: '10.2.3.6' });
    expect(db.sqlite.prepare('SELECT position FROM tv_devices WHERE host = ?').get('10.2.3.6')).toEqual({ position: 13 });
  } finally { db.close(); }
});

test('mixedPlatformsRoundTrip', async () => {
  const dataDir = await directory();
  const cipher = await loadClientKeyCipher({ directory: dataDir, hasStoredKey: false });
  const lg: repositories.StoredTv = { host: tv.host, identity: tv.identity, macAddress: tv.macAddress, platform: 'webos', encryptedCredential: cipher.encrypt('synthetic-lg-key') };
  const samsung: repositories.StoredTv = { ...lg, host: '10.2.3.5', platform: 'tizen', identity: { model: 'Synthetic Samsung' }, macAddress: null, encryptedCredential: cipher.encrypt('synthetic-samsung-token') };
  const db = await openDatabase({ dataDir });
  try {
    const repo = repositories.createTvDeviceRepository(db.sqlite);
    repo.forDevice(first).replace(lg);
    repo.forDevice(second).replace(samsung);
    for (const platform of ['unknown', '', null, undefined]) expect(() => repo.forDevice(second).replace({ ...samsung, platform } as unknown as repositories.StoredTv)).toThrow();
    for (const encryptedCredential of ['', null, { version: 2 }, { ...samsung.encryptedCredential, ciphertext: '' }]) expect(() => repo.forDevice(second).replace({ ...samsung, encryptedCredential } as unknown as repositories.StoredTv)).toThrow();
    expect(repo.forDevice(second).load()).toEqual(samsung);
  } finally { db.close(); }
  const reopened = await openDatabase({ dataDir });
  try {
    const repo = repositories.createTvDeviceRepository(reopened.sqlite);
    expect(repo.list()).toEqual([{ tvId: first, platform: 'webos' }, { tvId: second, platform: 'tizen' }]);
    expect(repo.forDevice(first).load()).toEqual(lg);
    expect(repo.forDevice(second).load()).toEqual(samsung);
    expect(repo.legacyId()).toBe(first);
    const restoredCipher = await loadClientKeyCipher({ directory: dataDir, hasStoredKey: true });
    expect(restoredCipher.decrypt(repo.forDevice(second).load()!.encryptedCredential)).toBe('synthetic-samsung-token');
    const legacy = repositories.createTvRepository(reopened.sqlite);
    legacy.replace({ ...lg, host: '10.2.3.6' });
    expect(repo.forDevice(second).load()).toEqual(samsung);
    expect(repo.forDevice(first).load()?.host).toBe('10.2.3.6');
    repo.remove(second);
    expect(repo.forDevice(first).load()?.host).toBe('10.2.3.6');
    expect(repo.legacyId()).toBe(first);
  } finally { reopened.close(); }
  const bytes = await readFile(join(dataDir, 'app.sqlite'));
  expect(bytes.includes(Buffer.from('synthetic-lg-key'))).toBe(false);
  expect(bytes.includes(Buffer.from('synthetic-samsung-token'))).toBe(false);
});

test('v5 migration recording failure preserves every v4 record and its recovery backup', async () => {
  const dataDir = await directory(); const old = new Database(join(dataDir, 'app.sqlite'));
  for (const migration of schemaMigrations.slice(0, 4)) { migration.up(old); old.prepare('INSERT INTO migration_version VALUES (?, 1)').run(migration.version); }
  const insert = old.prepare("INSERT INTO tv_devices (tv_id, platform, host, identity_json, encrypted_client_key_json, mac_address) VALUES (?, 'webos', ?, ?, ?, ?)");
  insert.run(first, tv.host, JSON.stringify(tv.identity), JSON.stringify(tv.encryptedCredential), tv.macAddress);
  insert.run(second, '10.2.3.5', JSON.stringify(tv.identity), JSON.stringify(tv.encryptedCredential), null);
  old.prepare('INSERT INTO tv_default VALUES (1, ?)').run(second);
  const priorRows = old.prepare('SELECT * FROM tv_devices ORDER BY position').all(); old.close();
  await expect(openDatabase({ dataDir, now: () => { throw new Error('synthetic recording failure'); } })).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED' });
  const unchanged = new Database(join(dataDir, 'app.sqlite'));
  try {
    expect(unchanged.prepare('SELECT * FROM tv_devices ORDER BY position').all()).toEqual(priorRows);
    expect(unchanged.prepare('SELECT tv_id FROM tv_default').get()).toEqual({ tv_id: second });
    expect(unchanged.prepare('SELECT max(version) AS version FROM migration_version').get()).toEqual({ version: 4 });
    expect(unchanged.pragma('foreign_key_check')).toEqual([]);
  } finally { unchanged.close(); }
  const backups = await readdir(join(dataDir, 'backups'));
  expect(backups).toHaveLength(1);
  const backup = new Database(join(dataDir, 'backups', backups[0]!), { readonly: true });
  try { expect(backup.prepare('SELECT * FROM tv_devices ORDER BY position').all()).toEqual(priorRows); } finally { backup.close(); }
  const upgraded = await openDatabase({ dataDir });
  try { expect(repositories.createTvDeviceRepository(upgraded.sqlite).list()).toHaveLength(2); } finally { upgraded.close(); }
});

test('malformed stored platform fails closed for load and enumeration', async () => {
  const db = await openDatabase({ dataDir: await directory() });
  try {
    const repo = repositories.createTvDeviceRepository(db.sqlite);
    repo.forDevice(first).replace(tv);
    db.sqlite.pragma('ignore_check_constraints = ON');
    db.sqlite.prepare('UPDATE tv_devices SET platform = ? WHERE tv_id = ?').run('unknown', first);
    expect(() => repo.list()).toThrow();
    expect(() => repo.forDevice(first).load()).toThrow();
    expect(repo.forDevice(first).hasStoredKey()).toBe(true);
  } finally { db.close(); }
});

test('migratesExistingLgWithoutReencrypting', async () => {
  const dataDir = await directory(); const old = new Database(join(dataDir, 'app.sqlite'));
  for (const migration of schemaMigrations.slice(0, 3)) { migration.up(old); old.prepare('INSERT INTO migration_version VALUES (?, 1)').run(migration.version); }
  const envelope = JSON.stringify(tv.encryptedCredential, null, 1);
  old.prepare('INSERT INTO tv_config VALUES (1, ?, ?, ?, ?)').run(tv.host, JSON.stringify(tv.identity), envelope, tv.macAddress);
  old.prepare("INSERT INTO owner VALUES (1, 'synthetic', 'synthetic-hash')").run();
  old.prepare("INSERT INTO sessions VALUES ('synthetic-token', 1, 1, 2, 'synthetic-csrf')").run(); old.close();
  const db = await openDatabase({ dataDir });
  try {
    expect(repositories).toHaveProperty('createTvDeviceRepository');
    const repo = repositories.createTvDeviceRepository(db.sqlite);
    expect(repo.list()).toHaveLength(1); const id = repo.legacyId()!;
    expect(repo.forDevice(id).load()).toEqual(tv);
    expect(db.sqlite.prepare('SELECT encrypted_credential_json FROM tv_devices').get()).toEqual({ encrypted_credential_json: envelope });
    expect(db.sqlite.prepare('SELECT token_hash FROM sessions').get()).toEqual({ token_hash: 'synthetic-token' });
    expect(db.sqlite.prepare('SELECT password_hash FROM owner').get()).toEqual({ password_hash: 'synthetic-hash' });
  } finally { db.close(); }
});

test('emptyDatabaseStaysEmpty', async () => {
  const db = await openDatabase({ dataDir: await directory() });
  try { expect(repositories).toHaveProperty('createTvDeviceRepository'); const repo = repositories.createTvDeviceRepository(db.sqlite); repo.forDevice(first); expect(repo.list()).toEqual([]); expect(repo.legacyId()).toBeNull(); }
  finally { db.close(); }
});

test('deleting default and last TV preserves valid storage after restart', async () => {
  const dataDir = await directory(); const db = await openDatabase({ dataDir });
  const repo = repositories.createTvDeviceRepository(db.sqlite);
  repo.forDevice(first).replace(tv); repo.forDevice(second).replace({ ...tv, host: '10.2.3.5' });
  repo.remove(first);
  expect(repo.legacyId()).toBe(second); expect(repo.forDevice(first).load()).toBeNull();
  expect(repo.forDevice(second).load()?.encryptedCredential).toEqual(tv.encryptedCredential);
  repo.remove(second); expect(repo.legacyId()).toBeNull(); db.close();
  const reopened = await openDatabase({ dataDir });
  try { expect(repositories.createTvDeviceRepository(reopened.sqlite).list()).toEqual([]); } finally { reopened.close(); }
});

test('idsAndDefaultSurviveRestart', async () => {
  const dataDir = await directory(); const db = await openDatabase({ dataDir });
  try { expect(repositories).toHaveProperty('createTvDeviceRepository'); const repo = repositories.createTvDeviceRepository(db.sqlite); repo.forDevice(first).replace(tv); repo.forDevice(second).replace({ ...tv, host: '10.2.3.5' }); }
  finally { db.close(); }
  const reopened = await openDatabase({ dataDir });
  try { const repo = repositories.createTvDeviceRepository(reopened.sqlite); expect(repo.list()).toEqual([{ tvId: first, platform: 'webos' }, { tvId: second, platform: 'webos' }]); expect(repo.legacyId()).toBe(first); repo.forDevice(first).replace({ ...tv, host: '10.2.3.6' }); expect(repo.hostOwner('10.2.3.6')).toBe(first); }
  finally { reopened.close(); }
});

test('duplicateHostsCannotReplaceOtherTv', async () => {
  const db = await openDatabase({ dataDir: await directory() });
  try { expect(repositories).toHaveProperty('createTvDeviceRepository'); const repo = repositories.createTvDeviceRepository(db.sqlite); repo.forDevice(first).replace(tv); repo.forDevice(second).replace({ ...tv, host: '10.2.3.5' }); expect(() => repo.forDevice(second).replace(tv)).toThrow(); expect(repo.forDevice(second).load()?.host).toBe('10.2.3.5'); expect(repo.forDevice(first).load()).toEqual(tv); expect(repo.legacyId()).toBe(first); }
  finally { db.close(); }
});

test('migrationFailureRollsBack', async () => {
  const dataDir = await directory(); const old = new Database(join(dataDir, 'app.sqlite'));
  for (const migration of schemaMigrations.slice(0, 3)) { migration.up(old); old.prepare('INSERT INTO migration_version VALUES (?, 1)').run(migration.version); }
  old.prepare('INSERT INTO tv_config VALUES (1, ?, ?, ?, ?)').run(tv.host, JSON.stringify(tv.identity), JSON.stringify(tv.encryptedCredential), tv.macAddress);
  old.close();
  await expect(openDatabase({ dataDir, now: () => { throw new Error('synthetic recording failure'); } })).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED' });
  const unchanged = new Database(join(dataDir, 'app.sqlite'));
  try { expect(unchanged.prepare('SELECT host FROM tv_config').get()).toEqual({ host: '10.2.3.4' }); expect(unchanged.prepare('SELECT max(version) AS version FROM migration_version').get()).toEqual({ version: 3 }); }
  finally { unchanged.close(); }
});
