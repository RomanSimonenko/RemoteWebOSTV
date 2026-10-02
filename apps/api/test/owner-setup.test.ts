import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { createOwnerRepository } from '../src/auth/repository.js';
import { createOwnerSetupService } from '../src/auth/service.js';
import { runSetupTokenCli } from '../src/auth/cli.js';
import { openDatabase } from '../src/storage/database.js';

const directories: string[] = [];
async function fixture(now = 1_000_000) {
  const dir = await mkdtemp(join(tmpdir(), 'remote-webos-owner-'));
  directories.push(dir);
  const database = await openDatabase({ dataDir: join(dir, 'data') });
  const repository = createOwnerRepository(database.sqlite);
  const service = createOwnerSetupService({ repository, now: () => now });
  return { database, repository, service };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test('token is random base64url, only its SHA-256 hash is stored, and it expires at 15 minutes', async () => {
  const { database, service } = await fixture();
  try {
    const token = await service.issueSetupToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const row = database.sqlite.prepare('SELECT token_hash, expires_at FROM setup_token').get() as { token_hash: string; expires_at: number };
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.token_hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(row.token_hash).not.toContain(token);
    expect(row.expires_at).toBe(1_900_000);
    await expect(service.claimOwner({ token, username: 'alice', password: 'correct horse battery staple' })).resolves.toBeUndefined();
    expect(database.sqlite.prepare('SELECT * FROM setup_token').all()).toEqual([]);
    const owner = database.sqlite.prepare('SELECT username, password_hash FROM owner').get() as { username: string; password_hash: string };
    expect(owner.username).toBe('alice');
    expect(owner.password_hash).not.toContain('correct horse battery staple');
    const disk = await readFile(database.sqlite.name);
    expect(disk.includes(Buffer.from(token))).toBe(false);
    expect(disk.includes(Buffer.from('correct horse battery staple'))).toBe(false);
    await expect(service.issueSetupToken()).rejects.toThrow();
  } finally { database.close(); }
});

test('expired, replaced, missing and malformed tokens cannot claim', async () => {
  const { database, repository, service } = await fixture();
  try {
    const old = await service.issueSetupToken();
    const current = await service.issueSetupToken();
    const input = { username: 'alice', password: 'correct horse battery staple' };
    await expect(service.claimOwner({ ...input, token: old })).rejects.toThrow();
    await expect(service.claimOwner({ ...input, token: 'missing' })).rejects.toThrow();
    await expect(service.claimOwner({ ...input, token: 'A'.repeat(43) })).rejects.toThrow();
    expect(repository.getSetupState()).toBe('unclaimed');
    database.sqlite.prepare('UPDATE setup_token SET expires_at = ?').run(1_000_000);
    await expect(service.claimOwner({ ...input, token: current })).rejects.toThrow();
    expect(repository.getSetupState()).toBe('unclaimed');
  } finally { database.close(); }
});

test('concurrent claims create one owner and a failed transaction preserves token', async () => {
  const { database, repository, service } = await fixture();
  try {
    const token = await service.issueSetupToken();
    database.sqlite.exec(`CREATE TRIGGER reject_owner BEFORE INSERT ON owner BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    await expect(service.claimOwner({ token, username: 'alice', password: 'correct horse battery staple' })).rejects.toThrow();
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM setup_token').get()).toEqual({ count: 1 });
    database.sqlite.exec('DROP TRIGGER reject_owner');
    const claims = await Promise.allSettled([
      service.claimOwner({ token, username: 'alice', password: 'correct horse battery staple' }),
      service.claimOwner({ token, username: 'bob', password: 'correct horse battery staple' }),
    ]);
    expect(claims.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM owner').get()).toEqual({ count: 1 });
    expect(repository.getSetupState()).toBe('claimed');
  } finally { database.close(); }
});

test('validation preserves whitespace and rejects out-of-bounds values', async () => {
  const { database, service } = await fixture();
  try {
    const token = await service.issueSetupToken();
    for (const username of ['', 'x'.repeat(65)]) {
      await expect(service.claimOwner({ token, username, password: 'correct horse battery staple' })).rejects.toThrow();
    }
    for (const password of ['short', 'x'.repeat(129)]) {
      await expect(service.claimOwner({ token, username: 'alice', password })).rejects.toThrow();
    }
    await service.claimOwner({ token, username: ' alice ', password: '  correct horse battery staple  ' });
    expect(database.sqlite.prepare('SELECT username FROM owner').get()).toEqual({ username: ' alice ' });
  } finally { database.close(); }
});

test('CLI uses only data-dir config and refuses to issue a token after claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-webos-cli-'));
  directories.push(dir);
  const env = { REMOTE_WEBOS_DATA_DIR: join(dir, 'data') };
  const printed: string[] = [];
  const errors: string[] = [];
  expect(await runSetupTokenCli({ args: ['setup-token'], env, stdout: (line) => printed.push(line), stderr: (line) => errors.push(line) })).toBe(0);
  expect(printed).toHaveLength(1);
  expect(printed[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const database = await openDatabase({ dataDir: env.REMOTE_WEBOS_DATA_DIR });
  try {
    await createOwnerSetupService({ repository: createOwnerRepository(database.sqlite) }).claimOwner({
      token: printed[0]!, username: 'alice', password: 'correct horse battery staple',
    });
  } finally { database.close(); }
  printed.length = 0;
  expect(await runSetupTokenCli({ args: ['setup-token'], env, stdout: (line) => printed.push(line), stderr: (line) => errors.push(line) })).toBe(1);
  expect(printed).toEqual([]);
  expect(errors.join(' ')).not.toMatch(/correct horse|[A-Za-z0-9_-]{43}/);
});
