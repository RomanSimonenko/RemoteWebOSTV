import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface Migration {
  readonly version: number;
  readonly up: (sqlite: Database.Database) => void;
}

export const ownerTableSql = `CREATE TABLE owner (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          username TEXT NOT NULL,
          password_hash TEXT NOT NULL
        )`;

export const tvConfigTableSql = `CREATE TABLE tv_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          host TEXT NOT NULL,
          identity_json TEXT NOT NULL,
          encrypted_client_key_json TEXT NOT NULL
        )`;

export const tvDevicesTableSql = `CREATE TABLE tv_devices (
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  tv_id TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform = 'webos'),
  host TEXT NOT NULL UNIQUE,
  identity_json TEXT NOT NULL,
  encrypted_client_key_json TEXT NOT NULL,
  mac_address TEXT
)`;
export const tvDefaultTableSql = `CREATE TABLE tv_default (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tv_id TEXT NOT NULL REFERENCES tv_devices(tv_id)
)`;

export const schemaMigrations: readonly Migration[] = [
  {
    version: 1,
    up(sqlite) {
      sqlite.exec(`
        CREATE TABLE migration_version (
          version INTEGER PRIMARY KEY CHECK (version > 0),
          applied_at INTEGER NOT NULL
        );
        ${ownerTableSql};
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
  {
    version: 2,
    up(sqlite) { sqlite.exec(tvConfigTableSql); },
  },
  {
    version: 3,
    up(sqlite) { sqlite.exec('ALTER TABLE tv_config ADD COLUMN mac_address TEXT'); },
  },
  {
    version: 4,
    up(sqlite) {
      sqlite.exec(`${tvDevicesTableSql}; ${tvDefaultTableSql};`);
      const existing = sqlite.prepare('SELECT host, identity_json, encrypted_client_key_json, mac_address FROM tv_config WHERE id = 1').get() as { host: string; identity_json: string; encrypted_client_key_json: string; mac_address: string | null } | undefined;
      if (existing) {
        const tvId = randomUUID();
        sqlite.prepare("INSERT INTO tv_devices (tv_id, platform, host, identity_json, encrypted_client_key_json, mac_address) VALUES (?, 'webos', ?, ?, ?, ?)")
          .run(tvId, existing.host, existing.identity_json, existing.encrypted_client_key_json, existing.mac_address);
        sqlite.prepare('INSERT INTO tv_default VALUES (1, ?)').run(tvId);
      }
      sqlite.exec('DROP TABLE tv_config');
    },
  },
];
