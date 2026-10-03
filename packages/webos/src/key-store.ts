import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { WebOsError } from './errors.js';
import { createClientKeyCipher, encryptedEnvelopeV1Schema } from './key-cipher.js';

const masterKeyLength = 32;

export interface ClientKeyStore {
  load(): Promise<string | undefined>;
  save(clientKey: string): Promise<void>;
  clear(): Promise<void>;
}

export interface KeyStoreFileSystem {
  readonly chmod: typeof chmod;
  readonly mkdir: typeof mkdir;
  readonly open: typeof open;
  readonly readFile: typeof readFile;
  readonly rename: typeof rename;
  readonly unlink: typeof unlink;
}

interface EncryptedFileKeyStoreOptions {
  readonly directory: string;
  readonly fileSystem?: KeyStoreFileSystem;
  readonly randomBytes?: typeof nodeRandomBytes;
}

const nodeFileSystem: KeyStoreFileSystem = {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
};

export class EncryptedFileKeyStore implements ClientKeyStore {
  readonly #directory: string;
  readonly #fileSystem: KeyStoreFileSystem;
  readonly #randomBytes: typeof nodeRandomBytes;
  #saveQueue: Promise<void> = Promise.resolve();

  constructor(options: EncryptedFileKeyStoreOptions) {
    this.#directory = options.directory;
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
  }

  async load(): Promise<string | undefined> {
    await this.#saveQueue;
    const encryptedPath = this.#encryptedPath();
    let serialized: string;

    try {
      serialized = await this.#fileSystem.readFile(encryptedPath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return undefined;
      }
      throw new WebOsError(
        'KEY_STORE_CORRUPT',
        `Unable to read encrypted client key at ${encryptedPath}`,
        { cause: error },
      );
    }

    try {
      const envelope = encryptedEnvelopeV1Schema.parse(JSON.parse(serialized));
      const masterKey = await this.#readMasterKey();
      try {
        return createClientKeyCipher(masterKey).decrypt(envelope);
      } catch (error) {
        throw new WebOsError('KEY_STORE_CORRUPT', `Encrypted client key at ${encryptedPath} is invalid`, {
          cause: error instanceof WebOsError ? error.cause : error,
        });
      }
    } catch (error) {
      if (error instanceof WebOsError) {
        throw error;
      }
      throw new WebOsError(
        'KEY_STORE_CORRUPT',
        `Encrypted client key at ${encryptedPath} is invalid`,
        { cause: error },
      );
    }
  }

  save(clientKey: string): Promise<void> {
    if (clientKey.length === 0) {
      return Promise.reject(
        new WebOsError(
          'KEY_STORE_WRITE_FAILED',
          'Refusing to persist an empty client key',
        ),
      );
    }

    const operation = this.#saveQueue.then(() => this.#persist(clientKey));
    this.#saveQueue = operation.catch(() => undefined);
    return operation;
  }

  async clear(): Promise<void> {
    await this.#saveQueue;
    try {
      await this.#fileSystem.unlink(this.#encryptedPath());
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw new WebOsError(
          'KEY_STORE_WRITE_FAILED',
          'Unable to clear the encrypted client key',
          { cause: error },
        );
      }
    }
  }

  async #persist(clientKey: string): Promise<void> {
    const masterKey = await this.#loadOrCreateMasterKey();
    const envelope = createClientKeyCipher(masterKey, this.#randomBytes).encrypt(clientKey);
    const temporaryPath = join(
      this.#directory,
      `client-key.enc.tmp-${process.pid}-${this.#randomBytes(8).toString('hex')}`,
    );
    let temporaryHandle: FileHandle | undefined;

    try {
      temporaryHandle = await this.#fileSystem.open(
        temporaryPath,
        'wx',
        0o600,
      );
      await temporaryHandle.writeFile(JSON.stringify(envelope), 'utf8');
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await this.#fileSystem.rename(temporaryPath, this.#encryptedPath());
    } catch (error) {
      await temporaryHandle?.close().catch(() => undefined);
      await this.#fileSystem.unlink(temporaryPath).catch(() => undefined);
      throw new WebOsError(
        'KEY_STORE_WRITE_FAILED',
        `Unable to atomically persist client key in ${this.#directory}`,
        { cause: error },
      );
    }
  }

  async #loadOrCreateMasterKey(): Promise<Buffer> {
    await this.#fileSystem.mkdir(this.#directory, {
      recursive: true,
      mode: 0o700,
    });
    const masterPath = this.#masterPath();

    try {
      const handle = await this.#fileSystem.open(masterPath, 'wx', 0o600);
      try {
        const masterKey = this.#randomBytes(masterKeyLength);
        await handle.writeFile(masterKey);
        await handle.sync();
        await this.#fileSystem.chmod(masterPath, 0o600);
        return masterKey;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw new WebOsError(
          'KEY_STORE_WRITE_FAILED',
          `Unable to create master key at ${masterPath}`,
          { cause: error },
        );
      }
    }

    return this.#readMasterKey();
  }

  async #readMasterKey(): Promise<Buffer> {
    const masterPath = this.#masterPath();
    try {
      const masterKey = await this.#fileSystem.readFile(masterPath);
      if (!Buffer.isBuffer(masterKey) || masterKey.length !== masterKeyLength) {
        throw new Error('Master key must contain exactly 32 bytes');
      }
      await this.#fileSystem.chmod(masterPath, 0o600);
      return masterKey;
    } catch (error) {
      if (error instanceof WebOsError) {
        throw error;
      }
      throw new WebOsError(
        'KEY_STORE_CORRUPT',
        `Master key at ${masterPath} is missing or invalid`,
        { cause: error },
      );
    }
  }

  #masterPath(): string {
    return join(this.#directory, 'master.key');
  }

  #encryptedPath(): string {
    return join(this.#directory, 'client-key.enc');
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
