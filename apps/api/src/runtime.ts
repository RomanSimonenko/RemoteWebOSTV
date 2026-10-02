import { buildApp } from './app.js';
import type { AppConfig } from './config.js';
import type { FastifyInstance } from 'fastify';
import type { EventEmitter } from 'node:events';
import { createOwnerRepository } from './auth/repository.js';
import { createOwnerSetupService } from './auth/service.js';
import { createAuthSessionService, loadAuthMasterKey } from './auth/sessions.js';
import { openDatabase } from './storage/database.js';
import { safeCauseTypes, safeListenTextResolver } from './security/logging.js';

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

export async function serveApi(app: FastifyInstance, config: AppConfig, signals: Pick<EventEmitter, 'once' | 'removeListener'> = process): Promise<string> {
  let closing = false;
  const removeSignals = () => {
    signals.removeListener('SIGINT', shutdown);
    signals.removeListener('SIGTERM', shutdown);
  };
  const shutdown = () => {
    if (closing) return;
    closing = true;
    removeSignals();
    void app.close().catch((error: unknown) => {
      process.exitCode = 1;
      app.log.error({ code: 'API_SHUTDOWN_FAILED', causeTypes: safeCauseTypes(error) }, 'API shutdown failed');
    });
  };
  signals.once('SIGINT', shutdown);
  signals.once('SIGTERM', shutdown);
  try {
    return await app.listen({ host: config.host, port: config.port, listenTextResolver: safeListenTextResolver });
  } catch (error) {
    closing = true;
    removeSignals();
    try {
      await app.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'API startup and cleanup both failed');
    }
    throw error;
  }
}
