import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { createApiRuntime } from '../src/runtime.js';
import { createOwnerRepository } from '../src/auth/repository.js';
import { createOwnerSetupService } from '../src/auth/service.js';
import { openDatabase } from '../src/storage/database.js';

test('startup setup status follows the persisted owner after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-runtime-'));
  const config: AppConfig = {
    dataDir: join(directory, 'data'), host: '127.0.0.1', port: 8080,
    publicOrigin: 'https://remote.example.test', secureCookies: true, trustedProxy: [],
  };
  try {
    const first = await createApiRuntime(config);
    expect((await first.inject('/api/setup/status')).json()).toEqual({ state: 'unclaimed' });
    await first.close();

    const database = await openDatabase({ dataDir: config.dataDir });
    try {
      const service = createOwnerSetupService({ repository: createOwnerRepository(database.sqlite) });
      const token = await service.issueSetupToken();
      await service.claimOwner({ token, username: 'alice', password: 'correct horse battery staple' });
    } finally { database.close(); }

    const second = await createApiRuntime(config);
    try {
      expect((await second.inject('/api/setup/status')).json()).toEqual({ state: 'claimed' });
    } finally { await second.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
