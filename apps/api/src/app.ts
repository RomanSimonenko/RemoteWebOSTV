import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { setupStatusSchema, type SetupState } from '@remote-webos-tv/contracts';

import type { AppConfig } from './config.js';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly getSetupState: () => Promise<SetupState>;
  readonly reportError?: (report: { readonly requestId: string; readonly status: number; readonly causeTypes: readonly string[] }) => void;
}

class StorageUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Storage unavailable', { cause });
    this.name = 'StorageUnavailableError';
  }
}

function safeCauseTypes(error: unknown): string[] {
  const types: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current) && types.length < 5) {
    seen.add(current);
    types.push(['Error', 'TypeError', 'SyntaxError', 'StorageUnavailableError', 'ZodError'].includes(current.name) ? current.name : 'OtherError');
    current = current.cause;
  }
  return types;
}

export function buildApp({ config, getSetupState, reportError = (report) => { console.error(JSON.stringify(report)); } }: AppDependencies) {
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: config.trustedProxy.length ? [...config.trustedProxy] : false,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url === '/api' || request.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const failure = typeof error === 'object' && error !== null ? error : {};
    const tooLarge = 'code' in failure && failure.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
    const reportedStatus = 'statusCode' in failure && typeof failure.statusCode === 'number' ? failure.statusCode : 500;
    const storageUnavailable = error instanceof StorageUnavailableError;
    const status = storageUnavailable ? 503 : tooLarge ? 413 : reportedStatus >= 400 && reportedStatus < 500 ? reportedStatus : 500;
    const code = storageUnavailable ? 'STORAGE_UNAVAILABLE' : tooLarge ? 'PAYLOAD_TOO_LARGE' : status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
    const message = storageUnavailable ? 'Storage unavailable' : tooLarge ? 'Payload too large' : status < 500 ? 'Bad request' : 'Internal server error';
    if (status >= 500) reportError({ requestId: request.id, status, causeTypes: safeCauseTypes(error) });
    reply.code(status).send({ code, message, requestId: request.id });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ code: 'NOT_FOUND', message: 'Not found', requestId: request.id });
  });

  app.get('/api/setup/status', async () => setupStatusSchema.parse({ state: await getSetupState() }));

  app.get('/api/health', async () => {
    try {
      setupStatusSchema.parse({ state: await getSetupState() });
    } catch (cause) {
      throw new StorageUnavailableError(cause);
    }
    return { status: 'ok' };
  });

  return app;
}
