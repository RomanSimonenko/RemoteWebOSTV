import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { ownerTableSql, schemaMigrations, type Migration } from './migrations.js';

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
    if (!existing.isFile()) throw new Error('Database path must be a regular file');
  }
  await chmod(path, 0o600);
}

function migrationVersion(sqlite: Database.Database, latestVersion: number): number {
  const tables = sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const names = new Set(tables.map(({ name }) => name));
  if (!names.has('migration_version')) {
    if (names.size !== 0) throw new Error('Unrecognized database schema');
    return 0;
  }

  const rows = sqlite.prepare('SELECT version, applied_at FROM migration_version ORDER BY version').all() as { version: unknown; applied_at: unknown }[];
  if (rows.length === 0) throw new Error('Invalid migration history');
  if (rows.some((row) => typeof row.version === 'number' && row.version > latestVersion)) {
    throw new Error('Database schema version is newer than this application');
  }
  rows.forEach((row, index) => {
    if (!Number.isSafeInteger(row.version) || row.version !== index + 1 || !Number.isSafeInteger(row.applied_at)) {
      throw new Error('Invalid migration history');
    }
  });
  const version = rows.length;
  if (version >= 1 && !['owner', 'setup_token', 'sessions'].every((name) => names.has(name))) {
    throw new Error('Incomplete database schema');
  }
  if (version >= 1) {
    const savedOwnerSql = sqlite.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').pluck().get('table', 'owner');
    // SQLite appends ADD COLUMN definitions before the closing parenthesis, preserving the v1 constraint prefix.
    const extendsOwnerTable = version > 1 && typeof savedOwnerSql === 'string' && savedOwnerSql.startsWith(ownerTableSql.slice(0, -1));
    if (savedOwnerSql !== ownerTableSql && !extendsOwnerTable) throw new Error('Owner table schema does not match migration history');
    try {
      sqlite.prepare('SELECT id, username, password_hash FROM owner LIMIT 0');
      sqlite.prepare('SELECT id, token_hash, expires_at FROM setup_token LIMIT 0');
      sqlite.prepare('SELECT token_hash, owner_id, created_at, expires_at, csrf_hash FROM sessions LIMIT 0');
    } catch (cause) {
      throw new Error('Incomplete database schema', { cause });
    }
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
    throw new Error('Application migrations cannot be omitted or replaced');
  }
  for (let index = 0; index < migrations.length; index++) {
    if (migrations[index]?.version !== index + 1) throw new Error('Migration definitions must be sequential');
  }

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dataDir)).isDirectory()) throw new Error('Data directory path must be a directory');
  await chmod(dataDir, 0o700);
  const path = join(dataDir, 'app.sqlite');
  await secureDatabaseFile(path);
  const sqlite = new Database(path);
  try {
    sqlite.pragma('foreign_keys = ON');
    const initialVersion = migrationVersion(sqlite, migrations.length);
    if (initialVersion > 0 && initialVersion < migrations.length) {
      await backupBeforeUpgrade(sqlite, dataDir, initialVersion);
    }

    sqlite.transaction(() => {
      const currentVersion = migrationVersion(sqlite, migrations.length);
      for (const migration of migrations.slice(currentVersion)) {
        migration.up(sqlite);
        sqlite.prepare('INSERT INTO migration_version (version, applied_at) VALUES (?, ?)').run(migration.version, now());
      }
      if (currentVersion < migrations.length) migrationVersion(sqlite, migrations.length);
    }).immediate();

    return { sqlite, close: () => sqlite.close() };
  } catch (error) {
    try {
      sqlite.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Database startup and cleanup both failed');
    }
    throw error;
  }
}
