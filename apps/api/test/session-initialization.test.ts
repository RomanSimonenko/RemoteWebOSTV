import { expect, test, vi } from 'vitest';

import type { OwnerRepository } from '../src/auth/repository.js';

const passwordProbe = vi.hoisted(() => ({
  finishHash: undefined as ((hash: string) => void) | undefined,
  hashCalls: 0,
  verifiedHashes: [] as string[],
}));

vi.mock('../src/auth/passwords.js', () => ({
  hashPassword: () => new Promise<string>((resolve) => {
    passwordProbe.hashCalls++;
    passwordProbe.finishHash = resolve;
  }),
  verifyPassword: async (_password: string, hash: string) => {
    passwordProbe.verifiedHashes.push(hash);
    return false;
  },
}));

import { createAuthSessionService } from '../src/auth/sessions.js';

test('session service finishes dummy hash before serving equally costly failed logins', async () => {
  const repository = {
    getOwnerCredentials: (username: string) => username === 'alice'
      ? { username: 'alice', passwordHash: 'owner-hash' }
      : undefined,
  } as OwnerRepository;
  let ready = false;
  const pending = Promise.resolve(createAuthSessionService({ repository, masterKey: Buffer.alloc(32) }));
  void pending.then(() => { ready = true; });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(passwordProbe.hashCalls).toBe(1);
  passwordProbe.finishHash?.('dummy-hash');
  const service = await pending;
  expect(await service.login('missing', 'long-password-123')).toBeUndefined();
  expect(await service.login('alice', 'long-password-123')).toBeUndefined();
  expect(passwordProbe.verifiedHashes).toEqual(['dummy-hash', 'owner-hash']);
  expect(passwordProbe.hashCalls).toBe(1);
});
