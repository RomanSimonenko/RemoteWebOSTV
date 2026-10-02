import { buildApp } from './app.js';
import type { AppConfig } from './config.js';
import { createOwnerRepository } from './auth/repository.js';
import { openDatabase } from './storage/database.js';

export async function createApiRuntime(config: AppConfig) {
  const database = await openDatabase({ dataDir: config.dataDir });
  try {
    const repository = createOwnerRepository(database.sqlite);
    const app = buildApp({ config, getSetupState: async () => repository.getSetupState() });
    app.addHook('onClose', async () => { database.close(); });
    return app;
  } catch (error) {
    database.close();
    throw error;
  }
}
