import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { ownerTableSql, tvConfigTableSql, tvDevicesTableSql, tvDefaultTableSql, schemaMigrations, type Migration } from './migrations.js';
import { StorageStartupError, type StorageErrorCode } from './errors.js';

export interface AppDatabase {
  readonly sqlite: Database.Database;
  close(): void;
}

export interface OpenDatabaseOptions {
  readonly dataDir: string;
  readonly now?: () => number;
  readonly migrations?: readonly Migration[];
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

async function secureDatabaseFile(path: string): Promise<void> {
  try {
    const file = await open(path, 'wx', 0o600);
    await file.close();
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await lstat(path);
    if (!existing.isFile()) throw new StorageStartupError('STORAGE_DATABASE_PATH_INVALID');
  }
  await chmod(path, 0o600);
}

function migrationVersion(sqlite: Database.Database, latestVersion: number): number {
  const tables = sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const names = new Set(tables.map(({ name }) => name));
  if (!names.has('migration_version')) {
    if (names.size !== 0) throw new StorageStartupError('STORAGE_SCHEMA_INVALID');
    return 0;
  }

  const rows = sqlite.prepare('SELECT version, applied_at FROM migration_version ORDER BY version').all() as { version: unknown; applied_at: unknown }[];
  if (rows.length === 0) throw new StorageStartupError('STORAGE_SCHEMA_INVALID');
  if (rows.some((row) => typeof row.version === 'number' && row.version > latestVersion)) {
    throw new StorageStartupError('STORAGE_SCHEMA_NEWER');
  }
  rows.forEach((row, index) => {
    if (!Number.isSafeInteger(row.version) || row.version !== index + 1 || !Number.isSafeInteger(row.applied_at)) {
      throw new StorageStartupError('STORAGE_SCHEMA_INVALID');
    }
  });
  const version = rows.length;
  if (version >= 1 && !['owner', 'setup_token', 'sessions'].every((name) => names.has(name))) {
    throw new StorageStartupError('STORAGE_SCHEMA_INVALID');
  }
  if (version >= 1) {
    const savedOwnerSql = sqlite.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').pluck().get('table', 'owner');
    // SQLite appends ADD COLUMN definitions before the closing parenthesis, preserving the v1 constraint prefix.
    const extendsOwnerTable = version > 1 && typeof savedOwnerSql === 'string' && savedOwnerSql.startsWith(ownerTableSql.slice(0, -1));
    if (savedOwnerSql !== ownerTableSql && !extendsOwnerTable) throw new StorageStartupError('STORAGE_OWNER_SCHEMA_INVALID');
    try {
      sqlite.prepare('SELECT id, username, password_hash FROM owner LIMIT 0');
      sqlite.prepare('SELECT id, token_hash, expires_at FROM setup_token LIMIT 0');
      sqlite.prepare('SELECT token_hash, owner_id, created_at, expires_at, csrf_hash FROM sessions LIMIT 0');
    } catch (cause) {
      throw new StorageStartupError('STORAGE_SCHEMA_INVALID', cause);
    }
  }
  if (version >= 2 && version < 4) {
    const savedTvSql = sqlite.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').pluck().get('table', 'tv_config');
    const extendsTvTable = version > 2 && typeof savedTvSql === 'string' && savedTvSql.startsWith(tvConfigTableSql.slice(0, -1));
    if (savedTvSql !== tvConfigTableSql && !extendsTvTable) throw new StorageStartupError('STORAGE_SCHEMA_INVALID');
    try {
      sqlite.prepare('SELECT id, host, identity_json, encrypted_client_key_json FROM tv_config LIMIT 0');
      if (version >= 3) {
        sqlite.prepare('SELECT mac_address FROM tv_config LIMIT 0');
        const columns = sqlite.pragma('table_info(tv_config)') as { name: string; type: string; notnull: number; dflt_value: unknown }[];
        const mac = columns.find((column) => column.name === 'mac_address');
        if (mac?.type !== 'TEXT' || mac.notnull !== 0 || mac.dflt_value !== null) {
          throw new StorageStartupError('STORAGE_SCHEMA_INVALID');
        }
      }
    } catch (cause) { throw new StorageStartupError('STORAGE_SCHEMA_INVALID', cause); }
  }
  if (version >= 4) {
    for (const [name, expected] of [['tv_devices', tvDevicesTableSql], ['tv_default', tvDefaultTableSql]]) {
      if (sqlite.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').pluck().get('table', name) !== expected) {
        throw new StorageStartupError('STORAGE_SCHEMA_INVALID');
      }
    }
    if (names.has('tv_config') || (sqlite.pragma('foreign_key_check') as unknown[]).length !== 0) throw new StorageStartupError('STORAGE_SCHEMA_INVALID');
    const count = (sqlite.prepare('SELECT count(*) AS count FROM tv_devices').get() as { count: number }).count;
    const defaults = (sqlite.prepare('SELECT count(*) AS count FROM tv_default').get() as { count: number }).count;
    if ((count === 0 && defaults !== 0) || (count > 0 && defaults !== 1)) throw new StorageStartupError('STORAGE_SCHEMA_INVALID');
  }
  return version;
}

async function backupBeforeUpgrade(sqlite: Database.Database, dataDir: string, version: number): Promise<void> {
  const backupDir = join(dataDir, 'backups');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  if (!(await lstat(backupDir)).isDirectory()) throw new Error('Backup path must be a directory');
  await chmod(backupDir, 0o700);
  const backupPath = join(backupDir, `app.sqlite.v${version}.${randomUUID()}.bak`);
  const file = await open(backupPath, 'wx', 0o600);
  await file.close();
  try {
    await sqlite.backup(backupPath);
    await chmod(backupPath, 0o600);
  } catch (error) {
    try {
      await unlink(backupPath);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Database backup failed and partial backup cleanup failed');
    }
    throw error;
  }
}

export async function openDatabase({ dataDir, now = Date.now, migrations = schemaMigrations }: OpenDatabaseOptions): Promise<AppDatabase> {
  if (migrations.length < schemaMigrations.length || schemaMigrations.some((migration, index) => migrations[index] !== migration)) {
    throw new StorageStartupError('STORAGE_MIGRATIONS_INVALID');
  }
  for (let index = 0; index < migrations.length; index++) {
    if (migrations[index]?.version !== index + 1) throw new StorageStartupError('STORAGE_MIGRATIONS_INVALID');
  }

  let sqlite: Database.Database | undefined;
  let stage: StorageErrorCode = 'STORAGE_OPEN_FAILED';
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (!(await lstat(dataDir)).isDirectory()) throw new StorageStartupError('STORAGE_DATA_DIRECTORY_INVALID');
    await chmod(dataDir, 0o700);
    const path = join(dataDir, 'app.sqlite');
    await secureDatabaseFile(path);
    sqlite = new Database(path);
    const connection = sqlite;
    stage = 'STORAGE_SCHEMA_INVALID';
    sqlite.pragma('foreign_keys = ON');
    const initialVersion = migrationVersion(sqlite, migrations.length);
    if (initialVersion > 0 && initialVersion < migrations.length) {
      stage = 'STORAGE_BACKUP_FAILED';
      await backupBeforeUpgrade(sqlite, dataDir, initialVersion);
    }

    stage = 'STORAGE_MIGRATION_FAILED';
    sqlite.transaction(() => {
      const currentVersion = migrationVersion(connection, migrations.length);
      for (const migration of migrations.slice(currentVersion)) {
        migration.up(connection);
        connection.prepare('INSERT INTO migration_version (version, applied_at) VALUES (?, ?)').run(migration.version, now());
      }
      if (currentVersion < migrations.length) migrationVersion(connection, migrations.length);
    }).immediate();

    return { sqlite, close() {
      try { connection.close(); } catch (cause) { throw new StorageStartupError('STORAGE_CLOSE_FAILED', cause); }
    } };
  } catch (error) {
    const failure = error instanceof StorageStartupError ? error : new StorageStartupError(stage, error);
    try {
      sqlite?.close();
    } catch (closeError) {
      throw new AggregateError([failure, new StorageStartupError('STORAGE_CLOSE_FAILED', closeError)], 'Database startup and cleanup both failed');
    }
    throw failure;
  }
}
