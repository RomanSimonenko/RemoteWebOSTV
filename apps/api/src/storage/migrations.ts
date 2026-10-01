import type Database from 'better-sqlite3';

export interface Migration {
  readonly version: number;
  readonly up: (sqlite: Database.Database) => void;
}

export const schemaMigrations: readonly Migration[] = [
  {
    version: 1,
    up(sqlite) {
      sqlite.exec(`
        CREATE TABLE migration_version (
          version INTEGER PRIMARY KEY CHECK (version > 0),
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE owner (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          username TEXT NOT NULL,
          password_hash TEXT NOT NULL
        );
        CREATE TABLE setup_token (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          token_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          owner_id INTEGER NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          csrf_hash TEXT NOT NULL
        );
      `);
    },
  },
];
