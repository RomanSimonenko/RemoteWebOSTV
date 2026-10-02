import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const parameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const prefix = 'scrypt$v1$32768$8$1$';
const saltLength = 16;
const keyLength = 64;
const maxHashLength = prefix.length + 22 + 1 + 86;

function validPassword(password: string): boolean {
  if (typeof password !== 'string') return false;
  const length = [...password].length;
  return length >= 12 && length <= 128;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, parameters, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string, entropy: (length: number) => Uint8Array = randomBytes): Promise<string> {
  if (!validPassword(password)) throw new Error('Password must contain 12 to 128 characters');
  const salt = Buffer.from(entropy(saltLength));
  if (salt.length !== saltLength) throw new Error('Password salt entropy source returned an invalid length');
  const key = await deriveKey(password, salt);
  return `${prefix}${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!validPassword(password) || typeof hash !== 'string' || hash.length !== maxHashLength || !hash.startsWith(prefix)) return false;
  const parts = hash.slice(prefix.length).split('$');
  const saltText = parts[0];
  const keyText = parts[1];
  if (parts.length !== 2 || !saltText || !keyText || !/^[A-Za-z0-9_-]{22}$/.test(saltText) || !/^[A-Za-z0-9_-]{86}$/.test(keyText)) return false;
  const salt = Buffer.from(saltText, 'base64url');
  const key = Buffer.from(keyText, 'base64url');
  if (salt.length !== saltLength || key.length !== keyLength || salt.toString('base64url') !== saltText || key.toString('base64url') !== keyText) return false;
  const candidate = await deriveKey(password, salt);
  return timingSafeEqual(candidate, key);
}
