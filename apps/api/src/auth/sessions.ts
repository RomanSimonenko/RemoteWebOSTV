import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { hashPassword, verifyPassword } from './passwords.js';
import type { OwnerRepository } from './repository.js';

const sessionLifetimeMs = 24 * 60 * 60 * 1000;
const cookiePattern = /^[A-Za-z0-9_-]{43}$/;
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactBytes(source: (length: number) => Uint8Array, length: number): Buffer {
  const value = Buffer.from(source(length));
  if (value.length !== length) throw new Error('Auth entropy source returned an invalid length');
  return value;
}

export class AuthMasterKeyStorageError extends Error {
  constructor(cause: unknown) {
    super('Auth storage unavailable', { cause });
    this.name = 'AuthMasterKeyStorageError';
  }
}

async function readOrCreateAuthMasterKey(dataDir: string, hasSessions: () => boolean, entropy: (length: number) => Uint8Array): Promise<Buffer> {
  const path = join(dataDir, 'auth-master.key');
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const existing = await lstat(path);
    if (!existing.isFile()) throw new Error('Auth master key storage is invalid');
    await chmod(path, 0o600);
    const key = await readFile(path);
    if (key.length !== 32) throw new Error('Auth master key storage is invalid');
    return key;
  }
  try {
    if (hasSessions()) throw new Error('Auth master key is missing while sessions exist');
    const key = exactBytes(entropy, 32);
    await file.writeFile(key);
    await file.close();
    return key;
  } catch (error) {
    try {
      await file.close();
      await unlink(path);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Auth master key initialization and cleanup failed');
    }
    throw error;
  }
}

export async function loadAuthMasterKey(dataDir: string, hasSessions: () => boolean, entropy: (length: number) => Uint8Array = nodeRandomBytes): Promise<Buffer> {
  try {
    return await readOrCreateAuthMasterKey(dataDir, hasSessions, entropy);
  } catch (cause) {
    throw new AuthMasterKeyStorageError(cause);
  }
}

export interface AuthSessionService {
  login(username: string, password: string): Promise<{ readonly username: string; readonly token: string } | undefined>;
  authenticate(token: string | undefined): { readonly username: string; readonly csrfToken: string } | undefined;
  verifyCsrf(token: string, supplied: unknown): boolean;
  revoke(token: string): void;
}

export async function createAuthSessionService(input: {
  readonly repository: OwnerRepository;
  readonly masterKey: Buffer;
  readonly now?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
}): Promise<AuthSessionService> {
  const { repository, masterKey, now = Date.now, randomBytes = nodeRandomBytes } = input;
  if (masterKey.length !== 32) throw new Error('Auth master key storage is invalid');
  // The absent-user path still performs the same asynchronous password derivation.
  const dummyHash = await hashPassword('dummy password for absent owner', () => Buffer.alloc(16));
  const csrfFor = (token: string) => createHmac('sha256', masterKey).update('csrf:v1:').update(token).digest('base64url');
  return {
    async login(username, password) {
      const owner = repository.getOwnerCredentials(username);
      const accepted = await verifyPassword(password, owner?.passwordHash ?? dummyHash);
      if (!owner || !accepted) return undefined;
      const token = exactBytes(randomBytes, 32).toString('base64url');
      const issuedAt = now();
      repository.createSession({
        tokenHash: digest(token), csrfHash: digest(csrfFor(token)), now: issuedAt, expiresAt: issuedAt + sessionLifetimeMs,
      });
      return { username: owner.username, token };
    },
    authenticate(token) {
      if (!token || !cookiePattern.test(token)) return undefined;
      const row = repository.findSession(digest(token), now());
      if (!row) return undefined;
      const csrfToken = csrfFor(token);
      if (!/^[a-f0-9]{64}$/.test(row.csrfHash) || !timingSafeEqual(Buffer.from(digest(csrfToken), 'hex'), Buffer.from(row.csrfHash, 'hex'))) return undefined;
      return { username: row.username, csrfToken };
    },
    verifyCsrf(token, supplied) {
      if (typeof supplied !== 'string' || !csrfPattern.test(supplied)) return false;
      const expected = csrfFor(token);
      return timingSafeEqual(Buffer.from(supplied, 'utf8'), Buffer.from(expected, 'utf8'));
    },
    revoke(token) { repository.revokeSession(digest(token)); },
  };
}
