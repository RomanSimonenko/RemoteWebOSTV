import { expect, test } from 'vitest';

import { hashPassword, verifyPassword } from '../src/auth/passwords.js';

test('scrypt hash verifies its password but rejects another', async () => {
  const hash = await hashPassword('correct horse battery staple');
  expect(hash).toMatch(/^scrypt\$v1\$32768\$8\$1\$/);
  expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  expect(await verifyPassword('wrong horse battery staple', hash)).toBe(false);
});

test('each password hash uses a unique 16-byte salt', async () => {
  let calls = 0;
  const entropy = (length: number) => Buffer.alloc(length, calls++);
  const first = await hashPassword('correct horse battery staple', entropy);
  const second = await hashPassword('correct horse battery staple', entropy);
  expect(first).not.toBe(second);
  expect(first.split('$')[5]).toBe(Buffer.alloc(16, 0).toString('base64url'));
  expect(second.split('$')[5]).toBe(Buffer.alloc(16, 1).toString('base64url'));
  expect(calls).toBe(2);
  expect(Buffer.from(first.split('$')[5]!, 'base64url')).toHaveLength(16);
  expect(Buffer.from(first.split('$')[6]!, 'base64url')).toHaveLength(64);
});

test('password verification rejects oversized candidates without deriving a key', async () => {
  const hash = await hashPassword('correct horse battery staple');
  expect(await verifyPassword('x'.repeat(129), hash)).toBe(false);
});

test('malformed, oversized, or altered-parameter hashes are rejected before scrypt', async () => {
  for (const hash of ['', 'scrypt$v1$32768$8$1$bad$bad', 'x'.repeat(10000),
    'scrypt$v1$1048576$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86),
    'scrypt$v2$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86)]) {
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(false);
  }
});
