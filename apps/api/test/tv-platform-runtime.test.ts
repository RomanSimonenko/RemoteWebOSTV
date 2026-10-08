import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { expect, test } from 'vitest';
import { loadClientKeyCipher } from '@remote-webos-tv/webos';
import { createApiRuntime } from '../src/runtime.js';
import { openDatabase } from '../src/storage/database.js';
import { createTvRepository } from '../src/tv/repository.js';
import { ControlledAdapter, barrier, drain, identity, succeed } from './support/tv-harness.js';

test('runtime reports optional metadata failure through the safe application logger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-metadata-'));
  const config = { dataDir: join(directory, 'data'), host: '127.0.0.1', port: 8080, publicOrigin: 'https://remote.example.test', secureCookies: true, trustedProxy: [] };
  const database = await openDatabase({ dataDir: config.dataDir });
  try {
    const cipher = await loadClientKeyCipher({ directory: config.dataDir, hasStoredKey: false });
    createTvRepository(database.sqlite).replace({ platform: 'webos', host: '192.168.1.10', identity, macAddress: null, encryptedCredential: cipher.encrypt('synthetic-key') });
  } finally { database.close(); }
  const chunks: string[] = [];
  const entered = barrier<ControlledAdapter>();
  const app = await createApiRuntime(config, {
    logStream: new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } }),
    createAdapter(_host, staging) {
      const adapter = Object.assign(new ControlledAdapter(staging), {
        readPlatformVersion: () => Promise.reject(new Error('private raw response key address')),
      });
      entered.resolve(adapter); return adapter;
    },
  });
  try {
    await succeed(await entered.promise); await drain();
    const logs = chunks.join('');
    expect(logs).toContain('TV_OPTIONAL_METADATA_UNAVAILABLE');
    expect(logs).toContain('read_failed');
    expect(logs).not.toMatch(/192\.168|synthetic-key|private raw|response key address/);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
