import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import { schemaMigrations } from '../src/storage/migrations.js';
import * as repositories from '../src/tv/repository.js';

const directories: string[] = [];
async function directory() { const value = await mkdtemp(join(tmpdir(), 'multi-tv-')); directories.push(value); return value; }
afterEach(async () => { for (const value of directories.splice(0)) await rm(value, { recursive: true, force: true }); });
const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const tv = { host: '10.2.3.4', identity: { model: 'Synthetic LG', platformVersion: '6.5' }, macAddress: '02:AB:CD:EF:00:01', encryptedClientKey: { version: 1 as const, algorithm: 'aes-256-gcm' as const, iv: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.from('synthetic').toString('base64'), authTag: Buffer.alloc(16, 2).toString('base64') } };

test('migratesExistingLgWithoutReencrypting', async () => {
  const dataDir = await directory(); const old = new Database(join(dataDir, 'app.sqlite'));
  for (const migration of schemaMigrations.slice(0, 3)) { migration.up(old); old.prepare('INSERT INTO migration_version VALUES (?, 1)').run(migration.version); }
  const envelope = JSON.stringify(tv.encryptedClientKey, null, 1);
  old.prepare('INSERT INTO tv_config VALUES (1, ?, ?, ?, ?)').run(tv.host, JSON.stringify(tv.identity), envelope, tv.macAddress);
  old.prepare("INSERT INTO owner VALUES (1, 'synthetic', 'synthetic-hash')").run();
  old.prepare("INSERT INTO sessions VALUES ('synthetic-token', 1, 1, 2, 'synthetic-csrf')").run(); old.close();
  const db = await openDatabase({ dataDir });
  try {
    expect(repositories).toHaveProperty('createTvDeviceRepository');
    const repo = repositories.createTvDeviceRepository(db.sqlite);
    expect(repo.list()).toHaveLength(1); const id = repo.legacyId()!;
    expect(repo.forDevice(id).load()).toEqual(tv);
    expect(db.sqlite.prepare('SELECT encrypted_client_key_json FROM tv_devices').get()).toEqual({ encrypted_client_key_json: envelope });
    expect(db.sqlite.prepare('SELECT token_hash FROM sessions').get()).toEqual({ token_hash: 'synthetic-token' });
    expect(db.sqlite.prepare('SELECT password_hash FROM owner').get()).toEqual({ password_hash: 'synthetic-hash' });
  } finally { db.close(); }
});

test('emptyDatabaseStaysEmpty', async () => {
  const db = await openDatabase({ dataDir: await directory() });
  try { expect(repositories).toHaveProperty('createTvDeviceRepository'); const repo = repositories.createTvDeviceRepository(db.sqlite); repo.forDevice(first); expect(repo.list()).toEqual([]); expect(repo.legacyId()).toBeNull(); }
  finally { db.close(); }
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
  old.prepare('INSERT INTO tv_config VALUES (1, ?, ?, ?, ?)').run(tv.host, JSON.stringify(tv.identity), JSON.stringify(tv.encryptedClientKey), tv.macAddress);
  old.close();
  await expect(openDatabase({ dataDir, now: () => { throw new Error('synthetic recording failure'); } })).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED' });
  const unchanged = new Database(join(dataDir, 'app.sqlite'));
  try { expect(unchanged.prepare('SELECT host FROM tv_config').get()).toEqual({ host: '10.2.3.4' }); expect(unchanged.prepare('SELECT max(version) AS version FROM migration_version').get()).toEqual({ version: 3 }); }
  finally { unchanged.close(); }
});
