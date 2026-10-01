import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  EncryptedFileKeyStore,
  type KeyStoreFileSystem,
} from '../src/key-store.js';

const syntheticClientKey = 'synthetic-client-key';
const createdDirectories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-tv-test-'));
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('EncryptedFileKeyStore', () => {
  test('creates a 32-byte master key with owner-only permissions', async () => {
    const directory = await createDirectory();
    const store = new EncryptedFileKeyStore({ directory });

    await store.save(syntheticClientKey);

    const handle = await open(join(directory, 'master.key'), 'r');
    const stat = await handle.stat();
    await handle.close();
    expect(stat.size).toBe(32);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('encrypts the client key and loads the original value', async () => {
    const directory = await createDirectory();
    const store = new EncryptedFileKeyStore({ directory });

    await store.save(syntheticClientKey);

    const encrypted = await readFile(join(directory, 'client-key.enc'), 'utf8');
    expect(encrypted).not.toContain(syntheticClientKey);
    await expect(store.load()).resolves.toBe(syntheticClientKey);
  });

  test('returns undefined when no encrypted key exists', async () => {
    const directory = await createDirectory();
    const store = new EncryptedFileKeyStore({ directory });

    await expect(store.load()).resolves.toBeUndefined();
  });

  test('clears only the encrypted client-key record and is idempotent', async () => {
    const directory = await createDirectory();
    const store = new EncryptedFileKeyStore({ directory });
    await store.save(syntheticClientKey);

    await store.clear();
    await store.clear();

    expect((await readdir(directory)).sort()).toEqual(['master.key']);
    await expect(store.load()).resolves.toBeUndefined();
    const masterKey = await open(join(directory, 'master.key'), 'r');
    const metadata = await masterKey.stat();
    await masterKey.close();
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  test('preserves the encrypted client-key record when deletion fails', async () => {
    const directory = await createDirectory();
    const encryptedPath = join(directory, 'client-key.enc');
    const initialStore = new EncryptedFileKeyStore({ directory });
    await initialStore.save(syntheticClientKey);
    const fileSystem: KeyStoreFileSystem = {
      chmod,
      mkdir,
      open,
      readFile,
      rename,
      unlink: async () => {
        throw Object.assign(new Error('synthetic permission failure'), {
          code: 'EACCES',
        });
      },
    };
    const store = new EncryptedFileKeyStore({ directory, fileSystem });

    await expect(store.clear()).rejects.toMatchObject({
      code: 'KEY_STORE_WRITE_FAILED',
    });
    await expect(readFile(encryptedPath, 'utf8')).resolves.toBeTruthy();
  });

  test('reports malformed ciphertext without deleting or replacing it', async () => {
    const directory = await createDirectory();
    const encryptedPath = join(directory, 'client-key.enc');
    const malformed = '{"version":1,"ciphertext":"truncated"}';
    await writeFile(encryptedPath, malformed, { mode: 0o600 });
    const store = new EncryptedFileKeyStore({ directory });

    await expect(store.load()).rejects.toMatchObject({
      code: 'KEY_STORE_CORRUPT',
    });
    await expect(readFile(encryptedPath, 'utf8')).resolves.toBe(malformed);
  });

  test('reports authentication failure for tampered ciphertext', async () => {
    const directory = await createDirectory();
    const encryptedPath = join(directory, 'client-key.enc');
    const store = new EncryptedFileKeyStore({ directory });
    await store.save(syntheticClientKey);
    const envelope = JSON.parse(await readFile(encryptedPath, 'utf8')) as {
      authTag: string;
    };
    envelope.authTag = Buffer.alloc(16, 0).toString('base64');
    await writeFile(encryptedPath, JSON.stringify(envelope), { mode: 0o600 });

    await expect(store.load()).rejects.toMatchObject({
      code: 'KEY_STORE_CORRUPT',
    });
  });

  test('serializes concurrent saves and leaves a readable final file', async () => {
    const directory = await createDirectory();
    const store = new EncryptedFileKeyStore({ directory });

    await Promise.all([
      store.save('synthetic-client-key-one'),
      store.save('synthetic-client-key-two'),
    ]);

    await expect(store.load()).resolves.toBe('synthetic-client-key-two');
  });

  test('cleans the temporary file when atomic rename fails', async () => {
    const directory = await createDirectory();
    const fileSystem: KeyStoreFileSystem = {
      chmod,
      mkdir,
      open,
      readFile,
      rename: async () => {
        throw new Error('synthetic rename failure');
      },
      unlink,
    };
    const store = new EncryptedFileKeyStore({ directory, fileSystem });

    await expect(store.save(syntheticClientKey)).rejects.toMatchObject({
      code: 'KEY_STORE_WRITE_FAILED',
    });
    expect((await readdir(directory)).sort()).toEqual(['master.key']);
  });
});
