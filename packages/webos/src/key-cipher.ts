import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { WebOsError } from './errors.js';

const masterKeyLength = 32;
const initializationVectorLength = 12;
const authenticationTagLength = 16;
const base64Schema = z.string().min(1).refine((value) => Buffer.from(value, 'base64').toString('base64') === value);

export const encryptedEnvelopeV1Schema = z.strictObject({
  version: z.literal(1),
  algorithm: z.literal('aes-256-gcm'),
  iv: base64Schema.refine((value) => Buffer.from(value, 'base64').length === initializationVectorLength),
  ciphertext: base64Schema,
  authTag: base64Schema.refine((value) => Buffer.from(value, 'base64').length === authenticationTagLength),
});
export type EncryptedEnvelopeV1 = Readonly<z.infer<typeof encryptedEnvelopeV1Schema>>;

export interface ClientKeyCipher {
  encrypt(key: string): EncryptedEnvelopeV1;
  decrypt(envelope: EncryptedEnvelopeV1): string;
}

// The file store owns its existing master-key lifecycle; both callers share this cipher.
export function createClientKeyCipher(masterKey: Buffer, randomBytes: typeof nodeRandomBytes = nodeRandomBytes): ClientKeyCipher {
  if (masterKey.length !== masterKeyLength) throw new WebOsError('KEY_STORE_CORRUPT', 'Master key must contain exactly 32 bytes');
  return {
    encrypt(key) {
      if (key.length === 0) throw new WebOsError('KEY_STORE_WRITE_FAILED', 'Refusing to persist an empty client key');
      try {
        const iv = randomBytes(initializationVectorLength);
        const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
        const ciphertext = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
        return encryptedEnvelopeV1Schema.parse({ version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), authTag: cipher.getAuthTag().toString('base64') });
      } catch (cause) {
        throw new WebOsError('KEY_STORE_WRITE_FAILED', 'Unable to encrypt client key', { cause });
      }
    },
    decrypt(value) {
      try {
        const envelope = encryptedEnvelopeV1Schema.parse(value);
        const decipher = createDecipheriv(envelope.algorithm, masterKey, Buffer.from(envelope.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
        if (plaintext.length === 0) throw new Error('Decrypted client key is empty');
        return plaintext;
      } catch (cause) {
        throw new WebOsError('KEY_STORE_CORRUPT', 'Encrypted client key is invalid', { cause });
      }
    },
  };
}

interface LoadClientKeyCipherOptions {
  readonly directory: string;
  readonly hasStoredKey: boolean;
  readonly randomBytes?: typeof nodeRandomBytes;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export async function loadClientKeyCipher({ directory, hasStoredKey, randomBytes = nodeRandomBytes }: LoadClientKeyCipherOptions): Promise<ClientKeyCipher> {
  const masterPath = join(directory, 'tv-master.key');
  async function readMaster(): Promise<Buffer> {
    try {
      if (!(await lstat(masterPath)).isFile()) throw new Error('TV master key must be a regular file');
      const key = await readFile(masterPath);
      if (key.length !== masterKeyLength) throw new Error('Master key must contain exactly 32 bytes');
      await chmod(masterPath, 0o600);
      return key;
    } catch (cause) {
      throw new WebOsError('KEY_STORE_CORRUPT', 'TV master key is missing or invalid', { cause });
    }
  }
  if (hasStoredKey) return createClientKeyCipher(await readMaster(), randomBytes);
  try {
    return createClientKeyCipher(await readMaster(), randomBytes);
  } catch (error) {
    if (!(error instanceof WebOsError) || !hasErrorCode(error.cause, 'ENOENT')) throw error;
  }

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const handle = await open(masterPath, 'wx', 0o600);
    let cipher: ClientKeyCipher;
    try {
      const key = randomBytes(masterKeyLength);
      cipher = createClientKeyCipher(key, randomBytes);
      await handle.writeFile(key);
      await handle.sync();
    } catch (cause) {
      const failures: unknown[] = [cause];
      try { await handle.close(); }
      catch (closeCause) { failures.push(closeCause); }
      // Remove only the incomplete file created by this invocation.
      try { await unlink(masterPath); }
      catch (cleanupCause) { failures.push(cleanupCause); }
      throw failures.length === 1 ? cause : new AggregateError(failures, 'TV master creation and cleanup failed');
    }
    await handle.close();
    return cipher;
  } catch (cause) {
    if (hasErrorCode(cause, 'EEXIST')) return createClientKeyCipher(await readMaster(), randomBytes);
    throw new WebOsError('KEY_STORE_WRITE_FAILED', 'Unable to create TV master key', { cause });
  }
}
