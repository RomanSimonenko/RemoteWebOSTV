import { buildApp } from './app.js';
import type { AppConfig } from './config.js';
import type { FastifyInstance } from 'fastify';
import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Writable } from 'node:stream';
import { Lgtv2Adapter, loadClientKeyCipher } from '@remote-webos-tv/webos';
import { createOwnerRepository } from './auth/repository.js';
import { createOwnerSetupService } from './auth/service.js';
import { createAuthSessionService, loadAuthMasterKey } from './auth/sessions.js';
import { openDatabase } from './storage/database.js';
import { safeCauseTypes, safeListenTextResolver } from './security/logging.js';
import { createTvRepository } from './tv/repository.js';
import { createTvService, type TvService, type TvServiceDependencies, type TvScheduler, type TvVersionDiagnostic } from './tv/service.js';

const runtimeScheduler: TvScheduler = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export async function createApiRuntime(config: AppConfig, options: {
  readonly now?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly webRoot?: string;
  readonly createAdapter?: TvServiceDependencies['createAdapter'];
  readonly scheduler?: TvScheduler;
  readonly newId?: () => string;
  readonly openDatabase?: typeof openDatabase;
  readonly logStream?: Writable;
} = {}) {
  const database = await (options.openDatabase ?? openDatabase)({ dataDir: config.dataDir });
  let tv: TvService | undefined;
  let logger: FastifyInstance['log'] | undefined;
  const pendingVersionDiagnostics: TvVersionDiagnostic[] = [];
  const logVersionDiagnostic = (diagnostic: TvVersionDiagnostic) => {
    if (!logger) { pendingVersionDiagnostics.push(diagnostic); return; }
    logger.warn({ code: 'TV_OPTIONAL_METADATA_UNAVAILABLE', operation: diagnostic.operation, diagnosticCode: diagnostic.code }, 'Optional TV metadata unavailable');
  };
  const closeResources = async () => {
    const failures: unknown[] = [];
    try { await tv?.close(); } catch (cause) { failures.push(cause); }
    try { database.close(); } catch (cause) { failures.push(cause); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'API resource cleanup failed');
  };
  try {
    const repository = createOwnerRepository(database.sqlite);
    const masterKey = await loadAuthMasterKey(config.dataDir, () => repository.hasSessions(), options.randomBytes);
    const sessions = await createAuthSessionService({ repository, masterKey, ...options });
    const tvRepository = createTvRepository(database.sqlite);
    // Initialize exactly one cipher before exposing HTTP, even with no saved TV.
    const cipher = await loadClientKeyCipher({ directory: config.dataDir, hasStoredKey: tvRepository.hasStoredKey() });
    const now = options.now ?? Date.now;
    tv = createTvService({
      repository: tvRepository, cipher, now, newId: options.newId ?? randomUUID,
      scheduler: options.scheduler ?? runtimeScheduler,
      recoveryTimeoutMs: config.recoveryTimeoutMs ?? 60_000,
      onVersionDiagnostic: logVersionDiagnostic,
      createAdapter: options.createAdapter ?? ((host, keyStore, requestTimeoutMs, allowPairingPrompt) => new Lgtv2Adapter({
        host, keyStore, requestTimeoutMs, handshakeTimeoutMs: requestTimeoutMs, allowPairingPrompt, now: () => new Date(now()),
        ...(config.wolBroadcastAddress === undefined ? {} : { wolBroadcastAddress: config.wolBroadcastAddress }),
      })),
    });
    await tv.initialize();
    const app = buildApp({
      config,
      tv,
      ...(options.logStream ? { logStream: options.logStream } : {}),
      ...(options.webRoot ? { webRoot: options.webRoot } : {}),
      getSetupState: async () => repository.getSetupState(),
      auth: {
        setup: createOwnerSetupService({ repository, ...options }),
        sessions,
      },
    });
    logger = app.log;
    for (const diagnostic of pendingVersionDiagnostics.splice(0)) logVersionDiagnostic(diagnostic);
    app.addHook('onClose', async () => {
      try { await closeResources(); }
      catch (cause) {
        app.log.error({ code: 'API_RESOURCE_CLEANUP_FAILED', causeTypes: safeCauseTypes(cause) }, 'API resource cleanup failed');
        throw cause;
      }
    });
    return app;
  } catch (error) {
    try { await closeResources(); } catch (closeError) {
      throw new AggregateError([error, closeError], 'API initialization and cleanup both failed');
    }
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
