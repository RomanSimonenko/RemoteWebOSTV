import { createCipheriv, createDecipheriv, type randomBytes } from 'node:crypto';
import { chmod, mkdtemp, open, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import * as webos from '../src/index.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

const directories: string[] = [];
async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'remote-webos-cipher-'));
  directories.push(value);
  return value;
}
afterEach(async () => {
  for (const value of directories.splice(0)) await rm(value, { recursive: true, force: true });
});

test('round-trips with a stable TV master key and a fresh IV per encryption', async () => {
  const dataDir = await directory();
  let entropyCall = 0;
  const entropy = ((length: number) => Buffer.alloc(length, ++entropyCall)) as typeof randomBytes;
  const cipher = await webos.loadClientKeyCipher({ directory: dataDir, hasStoredKey: false, randomBytes: entropy });
  const one = cipher.encrypt('synthetic-client-key');
  const two = cipher.encrypt('synthetic-client-key');
  expect(one.iv).not.toBe(two.iv);
  expect(JSON.stringify(one)).not.toContain('synthetic-client-key');
  expect(cipher.decrypt(one)).toBe('synthetic-client-key');
  const reopened = await webos.loadClientKeyCipher({ directory: dataDir, hasStoredKey: true });
  expect(reopened.decrypt(two)).toBe('synthetic-client-key');
  expect(await readdir(dataDir)).toEqual(['tv-master.key']);
  expect((await stat(join(dataDir, 'tv-master.key'))).mode & 0o777).toBe(0o600);
  expect((await readFile(join(dataDir, 'tv-master.key'))).length).toBe(32);
});

test.each(['authTag', 'ciphertext'] as const)('rejects tampered %s', async (field) => {
  const cipher = await webos.loadClientKeyCipher({ directory: await directory(), hasStoredKey: false });
  const envelope = cipher.encrypt('synthetic-client-key');
  const bytes = Buffer.from(envelope[field], 'base64');
  bytes[0] = bytes[0]! ^ 1;
  expect(() => cipher.decrypt({ ...envelope, [field]: bytes.toString('base64') })).toThrow(expect.objectContaining({ code: 'KEY_STORE_CORRUPT' }));
});

test('rejects an envelope encrypted by a different master key', async () => {
  const one = await webos.loadClientKeyCipher({ directory: await directory(), hasStoredKey: false });
  const two = await webos.loadClientKeyCipher({ directory: await directory(), hasStoredKey: false });
  expect(() => two.decrypt(one.encrypt('synthetic-client-key'))).toThrow(expect.objectContaining({ code: 'KEY_STORE_CORRUPT' }));
});

test('refuses empty plaintext and malformed versioned envelopes', async () => {
  const cipher = await webos.loadClientKeyCipher({ directory: await directory(), hasStoredKey: false });
  expect(() => cipher.encrypt('')).toThrow(expect.objectContaining({ code: 'KEY_STORE_WRITE_FAILED' }));
  const envelope = cipher.encrypt('synthetic-client-key');
  for (const value of [{ ...envelope, version: 2 }, { ...envelope, iv: 'invalid' }, { ...envelope, extra: true }]) {
    expect(() => cipher.decrypt(value as typeof envelope)).toThrow(expect.objectContaining({ code: 'KEY_STORE_CORRUPT' }));
  }
});

test('fails closed without generating a master when a stored key exists', async () => {
  const dataDir = await directory();
  await expect(webos.loadClientKeyCipher({ directory: dataDir, hasStoredKey: true })).rejects.toMatchObject({ code: 'KEY_STORE_CORRUPT' });
  expect(await readdir(dataDir)).toEqual([]);
  const cipher = await webos.loadClientKeyCipher({ directory: dataDir, hasStoredKey: false });
  cipher.encrypt('synthetic-client-key');
  await unlink(join(dataDir, 'tv-master.key'));
  await expect(webos.loadClientKeyCipher({ directory: dataDir, hasStoredKey: true })).rejects.toMatchObject({ code: 'KEY_STORE_CORRUPT' });
  expect(await readdir(dataDir)).toEqual([]);
});

test('preserves an invalid master and exposes its read failure', async () => {
  const dataDir = await directory();
  await writeFile(join(dataDir, 'tv-master.key'), 'synthetic-invalid-master');
  await expect(webos.loadClientKeyCipher({ directory: dataDir, hasStoredKey: false })).rejects.toMatchObject({ code: 'KEY_STORE_CORRUPT', cause: expect.any(Error) });
  expect(await readFile(join(dataDir, 'tv-master.key'), 'utf8')).toBe('synthetic-invalid-master');
});

test('reports master read failure when the data path is occupied', async () => {
  const dataDir = await directory();
  const occupied = join(dataDir, 'occupied');
  await writeFile(occupied, 'synthetic-occupied');
  await expect(webos.loadClientKeyCipher({ directory: occupied, hasStoredKey: false })).rejects.toMatchObject({ code: 'KEY_STORE_CORRUPT', cause: expect.any(Error) });
});

test('cleans an incomplete master and preserves the cause when entropy fails', async () => {
  const dataDir = await directory();
  const cause = new Error('synthetic entropy failure');
  const entropy = (() => { throw cause; }) as typeof randomBytes;
  await expect(webos.loadClientKeyCipher({ directory: dataDir, hasStoredKey: false, randomBytes: entropy })).rejects.toMatchObject({ code: 'KEY_STORE_WRITE_FAILED', cause });
  expect(await readdir(dataDir)).toEqual([]);
});

test('keeps both the creation failure and close failure when master cleanup also fails', async () => {
  const dataDir = await directory();
  const primary = new Error('synthetic entropy failure');
  const cleanup = new Error('synthetic close failure');
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
    const handle = await original.open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => { await close(); throw cleanup; };
    return handle;
  });
  const entropy = (() => { throw primary; }) as typeof randomBytes;
  const failure = await webos.loadClientKeyCipher({ directory: dataDir, hasStoredKey: false, randomBytes: entropy }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: 'KEY_STORE_WRITE_FAILED', cause: expect.any(AggregateError) });
  expect((failure as Error).cause).toMatchObject({ errors: [primary, cleanup] });
  expect(await readdir(dataDir)).toEqual([]);
});

test('rejects a master symlink without reading or changing its target', async () => {
  const dataDir = await directory();
  const outside = join(await directory(), 'synthetic-master');
  await writeFile(outside, Buffer.alloc(32, 3), { mode: 0o644 });
  await symlink(outside, join(dataDir, 'tv-master.key'));
  await expect(webos.loadClientKeyCipher({ directory: dataDir, hasStoredKey: false })).rejects.toMatchObject({ code: 'KEY_STORE_CORRUPT' });
  expect((await stat(outside)).mode & 0o777).toBe(0o644);
});

test('repairs existing master permissions without changing its bytes', async () => {
  const dataDir = await directory();
  await writeFile(join(dataDir, 'tv-master.key'), Buffer.alloc(32, 7), { mode: 0o644 });
  await chmod(join(dataDir, 'tv-master.key'), 0o644);
  await webos.loadClientKeyCipher({ directory: dataDir, hasStoredKey: false });
  expect((await stat(join(dataDir, 'tv-master.key'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(dataDir, 'tv-master.key'))).toEqual(Buffer.alloc(32, 7));
});

test('reads the original CLI envelope and preserves its independent master filename', async () => {
  const dataDir = await directory();
  const master = Buffer.alloc(32, 3);
  const iv = Buffer.alloc(12, 4);
  const aes = createCipheriv('aes-256-gcm', master, iv);
  const ciphertext = Buffer.concat([aes.update('synthetic-cli-key', 'utf8'), aes.final()]);
  await writeFile(join(dataDir, 'master.key'), master);
  await writeFile(join(dataDir, 'client-key.enc'), JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), authTag: aes.getAuthTag().toString('base64') }));
  const store = new webos.EncryptedFileKeyStore({ directory: dataDir });
  await expect(store.load()).resolves.toBe('synthetic-cli-key');
  await store.save('synthetic-replacement-key');
  const saved = JSON.parse(await readFile(join(dataDir, 'client-key.enc'), 'utf8'));
  expect(Object.keys(saved).sort()).toEqual(['algorithm', 'authTag', 'ciphertext', 'iv', 'version']);
  expect(saved).toMatchObject({ version: 1, algorithm: 'aes-256-gcm' });
  const decoder = createDecipheriv('aes-256-gcm', master, Buffer.from(saved.iv, 'base64'));
  decoder.setAuthTag(Buffer.from(saved.authTag, 'base64'));
  expect(Buffer.concat([decoder.update(Buffer.from(saved.ciphertext, 'base64')), decoder.final()]).toString('utf8')).toBe('synthetic-replacement-key');
  await expect(new webos.EncryptedFileKeyStore({ directory: dataDir }).load()).resolves.toBe('synthetic-replacement-key');
  expect(await readFile(join(dataDir, 'master.key'))).toEqual(master);
  expect((await stat(join(dataDir, 'client-key.enc'))).mode & 0o777).toBe(0o600);
  expect((await readdir(dataDir)).sort()).toEqual(['client-key.enc', 'master.key']);
});

test('preserves the CLI corruption diagnostic and authentication cause', async () => {
  const dataDir = await directory();
  const store = new webos.EncryptedFileKeyStore({ directory: dataDir });
  await store.save('synthetic-cli-key');
  const envelope = JSON.parse(await readFile(join(dataDir, 'client-key.enc'), 'utf8'));
  envelope.authTag = Buffer.alloc(16).toString('base64');
  await writeFile(join(dataDir, 'client-key.enc'), JSON.stringify(envelope));
  await expect(store.load()).rejects.toMatchObject({ code: 'KEY_STORE_CORRUPT', message: expect.stringMatching(/Encrypted client key at .* is invalid/), cause: expect.any(Error) });
});
