import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';

export function createSetupToken(randomBytes: (length: number) => Uint8Array = cryptoRandomBytes): string {
  const bytes = randomBytes(32);
  if (bytes.length !== 32) throw new Error('Setup token entropy source returned an invalid length');
  return Buffer.from(bytes).toString('base64url');
}

export function hashSetupToken(token: string): string | undefined {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== token) return undefined;
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
