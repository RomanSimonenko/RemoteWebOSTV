import { statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';

import { openDatabase } from '../src/storage/database.js';
import { schemaMigrations } from '../src/storage/migrations.js';

const temporaryDirectories: string[] = [];

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-storage-'));
  temporaryDirectories.push(directory);
  return join(directory, 'data');
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test('creates a private database with the auth schema and foreign keys enabled', async () => {
  const dataDir = await dataDirectory();
  const database = await openDatabase({ dataDir, now: () => 1234 });
  try {
    const tables = database.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(tables).toEqual([
      { name: 'migration_version' }, { name: 'owner' }, { name: 'sessions' }, { name: 'setup_token' }, { name: 'tv_default' }, { name: 'tv_devices' },
    ]);
    expect(database.sqlite.prepare('SELECT version, applied_at FROM migration_version').all()).toEqual([{ version: 1, applied_at: 1234 }, { version: 2, applied_at: 1234 }, { version: 3, applied_at: 1234 }, { version: 4, applied_at: 1234 }, { version: 5, applied_at: 1234 }]);
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dataDir, 'app.sqlite'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dataDir)).toEqual(['app.sqlite']);
  } finally {
    database.close();
  }
});

test('does not allow an injected migration list to omit the application schema', async () => {
  const dataDir = await dataDirectory();
  await expect(openDatabase({ dataDir, migrations: [] })).rejects.toThrow(/application migration/i);
});

test('preserves owner data on restart and prevents a second owner at the database boundary', async () => {
  const dataDir = await dataDirectory();
  const first = await openDatabase({ dataDir });
  first.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'owner', 'synthetic-hash');
  expect(() => first.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'other', 'synthetic-hash')).toThrow();
  first.close();

  const reopened = await openDatabase({ dataDir });
  try {
    expect(reopened.sqlite.prepare('SELECT id, username, password_hash FROM owner').all()).toEqual([
      { id: 1, username: 'owner', password_hash: 'synthetic-hash' },
    ]);
    expect(reopened.sqlite.prepare('SELECT version FROM migration_version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
    expect(await readdir(dataDir)).toEqual(['app.sqlite']);
  } finally {
    reopened.close();
  }
});

test('rolls back a failed upgrade and retains a private SQLite recovery backup of prior data', async () => {
  const dataDir = await dataDirectory();
  const first = await openDatabase({ dataDir });
  first.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'owner', 'synthetic-hash');
  first.close();

  let failedConnection: Database.Database | undefined;
  await expect(openDatabase({
    dataDir,
    migrations: [...schemaMigrations, {
      version: 6,
      up(sqlite) {
        failedConnection = sqlite;
        sqlite.exec('CREATE TABLE partial_upgrade (value TEXT)');
        throw new Error('injected migration failure');
      },
    }],
  })).rejects.toMatchObject({ code: 'STORAGE_MIGRATION_FAILED', cause: { message: 'injected migration failure' } });
  expect(failedConnection?.open).toBe(false);

  const names = await readdir(join(dataDir, 'backups'));
  expect(names).toHaveLength(1);
  const backupPath = join(dataDir, 'backups', names[0]!);
  expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  const backup = new Database(backupPath, { readonly: true });
  try {
    expect(backup.prepare('SELECT username FROM owner WHERE id = 1').get()).toEqual({ username: 'owner' });
    expect(backup.prepare('SELECT version FROM migration_version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
  } finally {
    backup.close();
  }

  const reopened = await openDatabase({ dataDir });
  try {
    expect(reopened.sqlite.prepare('SELECT username FROM owner WHERE id = 1').get()).toEqual({ username: 'owner' });
    expect(reopened.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'partial_upgrade'").get()).toBeUndefined();
    expect(reopened.sqlite.prepare('SELECT version FROM migration_version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
  } finally {
    reopened.close();
  }
});

test('rejects malformed migration history and missing schema tables', async () => {
  for (const damage of [
    (sqlite: Database.Database) => sqlite.prepare('DELETE FROM migration_version').run(),
    (sqlite: Database.Database) => sqlite.exec('DROP TABLE owner'),
  ]) {
    const dataDir = await dataDirectory();
    const database = await openDatabase({ dataDir });
    damage(database.sqlite);
    database.close();
    await expect(openDatabase({ dataDir })).rejects.toThrow(/schema|migration/i);
  }
});

test('identifies a database version newer than the application', async () => {
  const dataDir = await dataDirectory();
  const database = await openDatabase({ dataDir });
  database.sqlite.prepare('INSERT INTO migration_version (version, applied_at) VALUES (?, ?)').run(99, 1234);
  database.close();

  await expect(openDatabase({ dataDir })).rejects.toThrow(/newer than this application/i);
});

test('rejects a schema whose recorded version hides missing columns', async () => {
  const dataDir = await dataDirectory();
  const database = await openDatabase({ dataDir });
  database.sqlite.exec('ALTER TABLE owner RENAME COLUMN password_hash TO broken_column');
  database.close();

  await expect(openDatabase({ dataDir })).rejects.toThrow(/schema|migration/i);
});

test('rejects a version-one owner table without the single-owner constraint', async () => {
  const dataDir = await dataDirectory();
  const database = await openDatabase({ dataDir });
  database.sqlite.exec(`
    DROP TABLE owner;
    CREATE TABLE owner (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
  `);
  database.close();

  await expect(openDatabase({ dataDir })).rejects.toThrow(/owner.*schema|schema.*owner/i);
});

test('reopens a later owner-column migration while preserving the single-owner constraint', async () => {
  const dataDir = await dataDirectory();
  const first = await openDatabase({ dataDir });
  first.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'owner', 'synthetic-hash');
  first.close();
  const migrations = [...schemaMigrations, {
    version: 6,
    up(sqlite: Database.Database) {
      sqlite.exec('ALTER TABLE owner ADD COLUMN display_name TEXT');
    },
  }];

  const upgraded = await openDatabase({ dataDir, migrations });
  upgraded.close();

  const reopened = await openDatabase({ dataDir, migrations });
  try {
    expect(reopened.sqlite.prepare('SELECT id, username, display_name FROM owner').all()).toEqual([
      { id: 1, username: 'owner', display_name: null },
    ]);
    expect(() => reopened.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'second', 'synthetic-hash')).toThrow();
  } finally {
    reopened.close();
  }
});

test('rejects a later owner migration that removes the single-owner constraint', async () => {
  const dataDir = await dataDirectory();
  const original = await openDatabase({ dataDir });
  original.close();
  const migrations = [...schemaMigrations, {
    version: 6,
    up(sqlite: Database.Database) {
      sqlite.exec(`
        DROP TABLE owner;
        CREATE TABLE owner (id INTEGER PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL);
      `);
    },
  }];
  await expect(openDatabase({ dataDir, migrations })).rejects.toThrow(/owner table schema/i);
  const reopened = await openDatabase({ dataDir });
  try {
    expect(reopened.sqlite.prepare('SELECT version FROM migration_version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
    expect(() => reopened.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'second', 'synthetic-hash')).toThrow();
  } finally {
    reopened.close();
  }
});

test('keeps an active rollback journal private', async () => {
  const dataDir = await dataDirectory();
  const database = await openDatabase({ dataDir });
  try {
    const journalMode = database.sqlite.pragma('journal_mode', { simple: true });
    expect(journalMode).toBe('delete');
    database.sqlite.transaction(() => {
      database.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'owner', 'synthetic-hash');
      expect(statSync(join(dataDir, 'app.sqlite-journal')).mode & 0o777).toBe(0o600);
    })();
  } finally {
    database.close();
  }
});

test('rejects a non-directory data path without creating a database', async () => {
  const dataDir = await dataDirectory();
  await writeFile(dataDir, 'occupied');
  await expect(openDatabase({ dataDir })).rejects.toThrow();
  expect(await readFile(dataDir, 'utf8')).toBe('occupied');
});

test('rejects a data directory symlink without changing its target', async () => {
  const dataDir = await dataDirectory();
  const outside = join(dirname(dataDir), 'outside');
  await mkdir(outside);
  await chmod(outside, 0o755);
  await symlink(outside, dataDir);

  await expect(openDatabase({ dataDir })).rejects.toThrow(/data directory/i);
  expect((await stat(outside)).mode & 0o777).toBe(0o755);
  expect(await readdir(outside)).toEqual([]);
});

test('refuses an upgrade when backup cannot be created and preserves existing data', async () => {
  const dataDir = await dataDirectory();
  const first = await openDatabase({ dataDir });
  first.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'owner', 'synthetic-hash');
  first.close();
  await writeFile(join(dataDir, 'backups'), 'occupied');

  await expect(openDatabase({
    dataDir,
    migrations: [...schemaMigrations, { version: 6, up: (sqlite) => sqlite.exec('CREATE TABLE upgraded (value TEXT)') }],
  })).rejects.toThrow();

  const reopened = await openDatabase({ dataDir });
  try {
    expect(reopened.sqlite.prepare('SELECT username FROM owner WHERE id = 1').get()).toEqual({ username: 'owner' });
    expect(reopened.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'upgraded'").get()).toBeUndefined();
  } finally {
    reopened.close();
  }
});

test('refuses to follow a backup directory symlink outside the private data directory', async () => {
  const dataDir = await dataDirectory();
  const first = await openDatabase({ dataDir });
  first.close();
  const outside = join(dirname(dataDir), 'outside');
  await mkdir(outside);
  await symlink(outside, join(dataDir, 'backups'));

  await expect(openDatabase({
    dataDir,
    migrations: [...schemaMigrations, { version: 6, up: (sqlite) => sqlite.exec('CREATE TABLE upgraded (value TEXT)') }],
  })).rejects.toThrow(/backup|directory/i);
  expect(await readdir(outside)).toEqual([]);
});

test('applies a pending upgrade once across simultaneous startup attempts', async () => {
  const dataDir = await dataDirectory();
  const original = await openDatabase({ dataDir });
  original.close();
  let upgrades = 0;
  const migrations = [...schemaMigrations, {
    version: 6,
    up(sqlite: Database.Database) {
      upgrades++;
      sqlite.exec('CREATE TABLE upgraded (value TEXT)');
    },
  }];
  const [first, second] = await Promise.all([
    openDatabase({ dataDir, migrations }),
    openDatabase({ dataDir, migrations }),
  ]);
  try {
    expect(upgrades).toBe(1);
    expect(first.sqlite.prepare('SELECT version FROM migration_version ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }]);
    expect(second.sqlite.prepare('SELECT version FROM migration_version ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }]);
  } finally {
    first.close();
    second.close();
  }
});
