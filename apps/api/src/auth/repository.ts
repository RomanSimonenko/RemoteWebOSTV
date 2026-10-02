import { timingSafeEqual } from 'node:crypto';

import type Database from 'better-sqlite3';

export interface OwnerRepository {
  getSetupState(): 'claimed' | 'unclaimed';
  replaceSetupToken(tokenHash: string, expiresAt: number): boolean;
  claimOwner(input: { readonly tokenHash: string; readonly username: string; readonly passwordHash: string; readonly now: number }): boolean;
  getOwnerCredentials(username: string): { readonly username: string; readonly passwordHash: string } | undefined;
  hasSessions(): boolean;
  createSession(input: { readonly tokenHash: string; readonly csrfHash: string; readonly now: number; readonly expiresAt: number }): void;
  findSession(tokenHash: string, now: number): { readonly username: string; readonly csrfHash: string } | undefined;
  revokeSession(tokenHash: string): void;
}

export function createOwnerRepository(sqlite: Database.Database): OwnerRepository {
  const ownerExists = sqlite.prepare('SELECT 1 FROM owner WHERE id = 1');
  const replaceToken = sqlite.prepare(`INSERT INTO setup_token (id, token_hash, expires_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at`);
  const selectToken = sqlite.prepare('SELECT token_hash, expires_at FROM setup_token WHERE id = 1');
  const insertOwner = sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (1, ?, ?)');
  const deleteToken = sqlite.prepare('DELETE FROM setup_token WHERE id = 1');
  const selectOwner = sqlite.prepare('SELECT username, password_hash FROM owner WHERE id = 1 AND username = ?');
  const selectAnySession = sqlite.prepare('SELECT 1 FROM sessions LIMIT 1');
  const insertSession = sqlite.prepare('INSERT INTO sessions (token_hash, owner_id, created_at, expires_at, csrf_hash) VALUES (?, 1, ?, ?, ?)');
  const selectSession = sqlite.prepare('SELECT owner.username, sessions.csrf_hash, sessions.created_at, sessions.expires_at FROM sessions JOIN owner ON sessions.owner_id = owner.id WHERE sessions.token_hash = ?');
  const deleteSession = sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?');

  return {
    getSetupState: () => ownerExists.get() ? 'claimed' : 'unclaimed',
    replaceSetupToken(tokenHash, expiresAt) {
      return sqlite.transaction(() => {
        if (ownerExists.get()) return false;
        replaceToken.run(tokenHash, expiresAt);
        return true;
      }).immediate();
    },
    claimOwner({ tokenHash, username, passwordHash, now }) {
      return sqlite.transaction(() => {
        if (ownerExists.get()) return false;
        const stored = selectToken.get() as { token_hash: string; expires_at: number } | undefined;
        if (!stored || !/^[a-f0-9]{64}$/.test(stored.token_hash) || !/^[a-f0-9]{64}$/.test(tokenHash) || stored.expires_at <= now) return false;
        if (!timingSafeEqual(Buffer.from(stored.token_hash, 'hex'), Buffer.from(tokenHash, 'hex'))) return false;
        insertOwner.run(username, passwordHash);
        deleteToken.run();
        return true;
      }).immediate();
    },
    getOwnerCredentials(username) {
      const row = selectOwner.get(username) as { username: string; password_hash: string } | undefined;
      return row ? { username: row.username, passwordHash: row.password_hash } : undefined;
    },
    hasSessions: () => Boolean(selectAnySession.get()),
    createSession({ tokenHash, csrfHash, now, expiresAt }) {
      insertSession.run(tokenHash, now, expiresAt, csrfHash);
    },
    findSession(tokenHash, now) {
      const row = selectSession.get(tokenHash) as { username: string; csrf_hash: string; created_at: number; expires_at: number } | undefined;
      if (!row) return undefined;
      if (row.expires_at <= now) {
        // Persist observed expiry so clock rollback or restart cannot revive it.
        // Authentication reads may maintain expired records, never valid ones.
        deleteSession.run(tokenHash);
        return undefined;
      }
      if (row.created_at > now) return undefined;
      return { username: row.username, csrfHash: row.csrf_hash };
    },
    revokeSession(tokenHash) { deleteSession.run(tokenHash); },
  };
}
