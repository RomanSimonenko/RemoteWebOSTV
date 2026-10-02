import { timingSafeEqual } from 'node:crypto';

import type Database from 'better-sqlite3';

export interface OwnerRepository {
  getSetupState(): 'claimed' | 'unclaimed';
  replaceSetupToken(tokenHash: string, expiresAt: number): boolean;
  claimOwner(input: { readonly tokenHash: string; readonly username: string; readonly passwordHash: string; readonly now: number }): boolean;
}

export function createOwnerRepository(sqlite: Database.Database): OwnerRepository {
  const ownerExists = sqlite.prepare('SELECT 1 FROM owner WHERE id = 1');
  const replaceToken = sqlite.prepare(`INSERT INTO setup_token (id, token_hash, expires_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at`);
  const selectToken = sqlite.prepare('SELECT token_hash, expires_at FROM setup_token WHERE id = 1');
  const insertOwner = sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (1, ?, ?)');
  const deleteToken = sqlite.prepare('DELETE FROM setup_token WHERE id = 1');

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
  };
}
