import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { loadClientKeyCipher } from '@remote-webos-tv/webos';
import { afterEach, expect, test } from 'vitest';

import { openDatabase } from '../src/storage/database.js';
import { schemaMigrations } from '../src/storage/migrations.js';
import { createTvRepository, type StoredTv } from '../src/tv/repository.js';

const directories: string[] = [];
async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-tv-storage-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const tv: StoredTv = {
  host: '10.23.45.67', identity: { model: 'Synthetic TV', platformVersion: 'synthetic-version' },
  macAddress: null,
  encryptedClientKey: { version: 1, algorithm: 'aes-256-gcm', iv: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.from('synthetic-ciphertext').toString('base64'), authTag: Buffer.alloc(16, 2).toString('base64') },
};

test('upgrades a v1 database with a recovery backup while preserving owner and sessions', async () => {
  const dataDir = await dataDirectory();
  const original = new Database(join(dataDir, 'app.sqlite'));
  schemaMigrations[0]!.up(original);
  original.prepare('INSERT INTO migration_version VALUES (1, 100)').run();
  original.prepare("INSERT INTO owner VALUES (1, 'synthetic-owner', 'synthetic-hash')").run();
  original.prepare("INSERT INTO sessions VALUES ('synthetic-token', 1, 10, 20, 'synthetic-csrf')").run();
  original.close();
  const database = await openDatabase({ dataDir, now: () => 200 });
  try {
    expect(database.sqlite.prepare('SELECT username FROM owner').get()).toEqual({ username: 'synthetic-owner' });
    expect(database.sqlite.prepare('SELECT token_hash FROM sessions').get()).toEqual({ token_hash: 'synthetic-token' });
    expect(database.sqlite.prepare('SELECT version, applied_at FROM migration_version ORDER BY version').all()).toEqual([{ version: 1, applied_at: 100 }, { version: 2, applied_at: 200 }, { version: 3, applied_at: 200 }]);
    expect(createTvRepository(database.sqlite).load()).toBeNull();
    const backups = await readdir(join(dataDir, 'backups'));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(dataDir, 'backups', backups[0]!), { readonly: true });
    try {
      expect(backup.prepare('SELECT version FROM migration_version').all()).toEqual([{ version: 1 }]);
      expect(backup.prepare('SELECT token_hash FROM sessions').get()).toEqual({ token_hash: 'synthetic-token' });
    } finally { backup.close(); }
  } finally { database.close(); }
});

test('stores one complete encrypted configuration and reloads it after reopening', async () => {
  const dataDir = await dataDirectory();
  const cipher = await loadClientKeyCipher({ directory: dataDir, hasStoredKey: false });
  const encryptedTv = { ...tv, macAddress: '02:AB:CD:EF:00:01', encryptedClientKey: cipher.encrypt('synthetic-client-key') };
  const database = await openDatabase({ dataDir });
  try {
    const repository = createTvRepository(database.sqlite);
    expect(repository.hasStoredKey()).toBe(false);
    repository.replace(encryptedTv);
    expect(repository.hasStoredKey()).toBe(true);
    const replacement = { ...encryptedTv, host: '10.23.45.68', identity: { model: 'Replacement TV' } };
    repository.replace(replacement);
    expect(repository.load()).toEqual(replacement);
    expect(database.sqlite.prepare('SELECT id FROM tv_config').all()).toEqual([{ id: 1 }]);
    expect(() => database.sqlite.prepare('INSERT INTO tv_config (id, host, identity_json, encrypted_client_key_json) VALUES (2, ?, ?, ?)').run(tv.host, '{}', '{}')).toThrow();
  } finally { database.close(); }
  const reopened = await openDatabase({ dataDir });
  try {
    const saved = createTvRepository(reopened.sqlite).load()!;
    expect(saved.host).toBe('10.23.45.68');
    expect(saved.macAddress).toBe('02:AB:CD:EF:00:01');
    expect(cipher.decrypt(saved.encryptedClientKey)).toBe('synthetic-client-key');
  }
  finally { reopened.close(); }
  expect((await readFile(join(dataDir, 'app.sqlite'))).includes(Buffer.from('synthetic-client-key'))).toBe(false);
});

test('rolls back a v1 to v2 upgrade when recording the migration fails', async () => {
  const dataDir = await dataDirectory();
  const original = new Database(join(dataDir, 'app.sqlite'));
  schemaMigrations[0]!.up(original);
  original.prepare('INSERT INTO migration_version VALUES (1, 100)').run();
  original.prepare("INSERT INTO owner VALUES (1, 'synthetic-owner', 'synthetic-hash')").run();
  original.close();
  await expect(openDatabase({ dataDir, now: () => { throw new Error('synthetic migration recording failure'); } })).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED' });
  const unchanged = new Database(join(dataDir, 'app.sqlite'));
  try {
    expect(unchanged.prepare('SELECT version FROM migration_version').all()).toEqual([{ version: 1 }]);
    expect(unchanged.prepare("SELECT name FROM sqlite_schema WHERE name = 'tv_config'").get()).toBeUndefined();
    expect(unchanged.prepare('SELECT username FROM owner').get()).toEqual({ username: 'synthetic-owner' });
  } finally { unchanged.close(); }
  const reopened = await openDatabase({ dataDir });
  reopened.close();
});

test('rolls back a replacement rejected inside SQLite and retains the prior configuration on reopen', async () => {
  const dataDir = await dataDirectory();
  const database = await openDatabase({ dataDir });
  try {
    const repository = createTvRepository(database.sqlite);
    repository.replace(tv);
    database.sqlite.exec("CREATE TRIGGER reject_tv_update AFTER UPDATE ON tv_config BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
    expect(() => repository.replace({ ...tv, host: '10.23.45.68', identity: { model: 'Rejected TV' } })).toThrow(/synthetic write failure/);
    expect(repository.load()).toEqual(tv);
  } finally { database.close(); }
  const reopened = await openDatabase({ dataDir });
  try { expect(createTvRepository(reopened.sqlite).load()).toEqual(tv); }
  finally { reopened.close(); }
});

test.each([
  ['host', ' https://synthetic.example.test '],
  ['host', ' 10.23.45.67 '],
  ['identity_json', '{"model":""}'],
  ['identity_json', '{"model":"TV","clientKey":"synthetic-secret"}'],
  ['identity_json', '{'],
  ['encrypted_client_key_json', '{"version":2}'],
  ['encrypted_client_key_json', '{'],
  ['mac_address', 'not-a-mac'],
  ['mac_address', '01:00:00:00:00:01'],
  ['mac_address', 'FF:FF:FF:FF:FF:FF'],
  ['mac_address', '00:00:00:00:00:00'],
] as const)('rejects stored malformed %s without treating it as absent', async (column, malformed) => {
  const database = await openDatabase({ dataDir: await dataDirectory() });
  try {
    const repository = createTvRepository(database.sqlite);
    repository.replace(tv);
    database.sqlite.prepare(`UPDATE tv_config SET ${column} = ?`).run(malformed);
    expect(repository.hasStoredKey()).toBe(true);
    expect(() => repository.load()).toThrow();
  } finally { database.close(); }
});

test('rejects malformed replacement input before changing stored state', async () => {
  const database = await openDatabase({ dataDir: await dataDirectory() });
  try {
    const repository = createTvRepository(database.sqlite);
    repository.replace(tv);
    expect(() => repository.replace({ ...tv, identity: { model: '' } })).toThrow();
    expect(() => repository.replace({ ...tv, host: ' 10.23.45.67 ' })).toThrow();
    expect(() => repository.replace({ ...tv, macAddress: 'invalid' })).toThrow();
    expect(() => repository.replace({ ...tv, macAddress: undefined } as unknown as StoredTv)).toThrow();
    expect(repository.load()).toEqual(tv);
  } finally { database.close(); }
});

test('upgrades a v2 TV row without altering key, identity, owner or session', async () => {
  const dataDir = await dataDirectory();
  const original = new Database(join(dataDir, 'app.sqlite'));
  for (const migration of schemaMigrations.slice(0, 2)) {
    migration.up(original);
    original.prepare('INSERT INTO migration_version VALUES (?, 100)').run(migration.version);
  }
  original.prepare("INSERT INTO owner VALUES (1, 'synthetic-owner', 'synthetic-hash')").run();
  original.prepare("INSERT INTO sessions VALUES ('synthetic-token', 1, 10, 20, 'synthetic-csrf')").run();
  const identityJson = JSON.stringify(tv.identity);
  const keyJson = JSON.stringify(tv.encryptedClientKey);
  original.prepare('INSERT INTO tv_config VALUES (1, ?, ?, ?)').run(tv.host, identityJson, keyJson);
  original.close();
  const database = await openDatabase({ dataDir, now: () => 200 });
  try {
    expect(createTvRepository(database.sqlite).load()).toEqual(tv);
    expect(database.sqlite.prepare('SELECT identity_json, encrypted_client_key_json, mac_address FROM tv_config').get()).toEqual({ identity_json: identityJson, encrypted_client_key_json: keyJson, mac_address: null });
    expect(database.sqlite.prepare('SELECT username, password_hash FROM owner').get()).toEqual({ username: 'synthetic-owner', password_hash: 'synthetic-hash' });
    expect(database.sqlite.prepare('SELECT token_hash FROM sessions').get()).toEqual({ token_hash: 'synthetic-token' });
    const backups = await readdir(join(dataDir, 'backups'));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(dataDir, 'backups', backups[0]!), { readonly: true });
    try {
      expect(backup.prepare('SELECT version FROM migration_version ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]);
      expect(backup.prepare('SELECT identity_json, encrypted_client_key_json FROM tv_config').get()).toEqual({ identity_json: identityJson, encrypted_client_key_json: keyJson });
    } finally { backup.close(); }
  } finally { database.close(); }
});

test('normalizes a manual MAC and explicitly clears it with null', async () => {
  const database = await openDatabase({ dataDir: await dataDirectory() });
  try {
    const repository = createTvRepository(database.sqlite);
    repository.replace({ ...tv, macAddress: '02-ab-cd-ef-00-01' });
    expect(repository.load()?.macAddress).toBe('02:AB:CD:EF:00:01');
    expect(database.sqlite.prepare('SELECT mac_address FROM tv_config').get()).toEqual({ mac_address: '02:AB:CD:EF:00:01' });
    repository.replace({ ...tv, macAddress: null });
    expect(repository.load()?.macAddress).toBeNull();
  } finally { database.close(); }
});

test('rejects a v3 schema that records migration but lacks its MAC column', async () => {
  const dataDir = await dataDirectory();
  const database = await openDatabase({ dataDir });
  database.sqlite.exec('DROP TABLE tv_config');
  schemaMigrations[1]!.up(database.sqlite);
  database.close();
  await expect(openDatabase({ dataDir }).then((unexpected) => { unexpected.close(); return unexpected; })).rejects.toMatchObject({ code: 'STORAGE_SCHEMA_INVALID' });
});

test.each(['INTEGER', 'TEXT NOT NULL DEFAULT \'\'', "TEXT DEFAULT '02:00:00:00:00:01'"])('rejects a v3 MAC column with incompatible definition %s', async (definition) => {
  const dataDir = await dataDirectory();
  const database = await openDatabase({ dataDir });
  database.sqlite.exec('DROP TABLE tv_config');
  schemaMigrations[1]!.up(database.sqlite);
  database.sqlite.exec(`ALTER TABLE tv_config ADD COLUMN mac_address ${definition}`);
  database.close();
  await expect(openDatabase({ dataDir }).then((unexpected) => { unexpected.close(); return unexpected; })).rejects.toMatchObject({ code: 'STORAGE_SCHEMA_INVALID' });
});

test('rolls back v2 MAC migration failure while preserving the complete TV row', async () => {
  const dataDir = await dataDirectory();
  const original = new Database(join(dataDir, 'app.sqlite'));
  for (const migration of schemaMigrations.slice(0, 2)) {
    migration.up(original);
    original.prepare('INSERT INTO migration_version VALUES (?, 100)').run(migration.version);
  }
  const keyJson = JSON.stringify(tv.encryptedClientKey);
  original.prepare('INSERT INTO tv_config VALUES (1, ?, ?, ?)').run(tv.host, JSON.stringify(tv.identity), keyJson);
  original.close();
  await expect(openDatabase({ dataDir, now: () => { throw new Error('synthetic recording failure'); } })).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED' });
  const unchanged = new Database(join(dataDir, 'app.sqlite'));
  try {
    expect(unchanged.prepare('SELECT version FROM migration_version ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(unchanged.prepare('SELECT encrypted_client_key_json FROM tv_config').get()).toEqual({ encrypted_client_key_json: keyJson });
    expect(() => unchanged.prepare('SELECT mac_address FROM tv_config')).toThrow();
  } finally { unchanged.close(); }
});

test.each(['missing', 'columns', 'singleton'] as const)('rejects v2 schema with %s TV table damage', async (damage) => {
  const dataDir = await dataDirectory();
  const database = await openDatabase({ dataDir });
  database.sqlite.exec('DROP TABLE tv_config');
  if (damage === 'columns') database.sqlite.exec('CREATE TABLE tv_config (id INTEGER PRIMARY KEY CHECK(id=1), host TEXT NOT NULL)');
  if (damage === 'singleton') database.sqlite.exec('CREATE TABLE tv_config (id INTEGER PRIMARY KEY, host TEXT NOT NULL, identity_json TEXT NOT NULL, encrypted_client_key_json TEXT NOT NULL)');
  database.close();
  await expect(openDatabase({ dataDir })).rejects.toMatchObject({ code: 'STORAGE_SCHEMA_INVALID' });
});
