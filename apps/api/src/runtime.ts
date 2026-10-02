import { buildApp } from './app.js';
import type { AppConfig } from './config.js';
import { createOwnerRepository } from './auth/repository.js';
import { createOwnerSetupService } from './auth/service.js';
import { createAuthSessionService, loadAuthMasterKey } from './auth/sessions.js';
import { openDatabase } from './storage/database.js';

export async function createApiRuntime(config: AppConfig, options: {
  readonly now?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly webRoot?: string;
} = {}) {
  const database = await openDatabase({ dataDir: config.dataDir });
  try {
    const repository = createOwnerRepository(database.sqlite);
    const masterKey = await loadAuthMasterKey(config.dataDir, () => repository.hasSessions(), options.randomBytes);
    const sessions = await createAuthSessionService({ repository, masterKey, ...options });
    const app = buildApp({
      config,
      ...(options.webRoot ? { webRoot: options.webRoot } : {}),
      getSetupState: async () => repository.getSetupState(),
      auth: {
        setup: createOwnerSetupService({ repository, ...options }),
        sessions,
      },
    });
    app.addHook('onClose', async () => { database.close(); });
    return app;
  } catch (error) {
    database.close();
    throw error;
  }
}
