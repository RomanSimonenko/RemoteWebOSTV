import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createOwnerRepository } from '../src/auth/repository.js';
import { createAuthSessionService } from '../src/auth/sessions.js';
import { openDatabase } from '../src/storage/database.js';

test('observed session expiry persists through clock rollback and database restart without changing owner or valid sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-expiry-'));
  const dataDir = join(directory, 'data');
  let database = await openDatabase({ dataDir });
  let now = 1000;
  const masterKey = Buffer.alloc(32, 1);
  try {
    database.sqlite.prepare('INSERT INTO owner (id, username, password_hash) VALUES (1, ?, ?)').run('alice', 'synthetic-hash');
    const repository = createOwnerRepository(database.sqlite);
    const token = Buffer.alloc(32, 2).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const csrf = createHmac('sha256', masterKey).update('csrf:v1:').update(token).digest('base64url');
    repository.createSession({ tokenHash, csrfHash: createHash('sha256').update(csrf).digest('hex'), now, expiresAt: 2000 });
    const ownerBefore = database.sqlite.prepare('SELECT * FROM owner').all();
    const sessionBefore = database.sqlite.prepare('SELECT * FROM sessions').all();
    const service = await createAuthSessionService({ repository, masterKey, now: () => now });
    const changes = () => database.sqlite.prepare('SELECT total_changes()').pluck().get();
    const changesBefore = changes();
    now = 999;
    expect.soft(service.authenticate(token)).toBeUndefined();
    now = 1999;
    expect(service.authenticate(token)?.username).toBe('alice');
    expect(database.sqlite.prepare('SELECT * FROM sessions').all()).toEqual(sessionBefore);
    expect(changes()).toBe(changesBefore);
    now = 2000;
    expect(service.authenticate(token)).toBeUndefined();
    now = 1999;
    expect(service.authenticate(token)).toBeUndefined();
    expect(database.sqlite.prepare('SELECT * FROM sessions').all()).toEqual([]);
    expect(database.sqlite.prepare('SELECT * FROM owner').all()).toEqual(ownerBefore);
    database.close();
    database = await openDatabase({ dataDir });
    const restarted = await createAuthSessionService({ repository: createOwnerRepository(database.sqlite), masterKey, now: () => now });
    expect(restarted.authenticate(token)).toBeUndefined();
    expect(database.sqlite.prepare('SELECT * FROM owner').all()).toEqual(ownerBefore);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
