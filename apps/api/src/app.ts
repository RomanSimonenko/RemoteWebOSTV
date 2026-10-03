import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { setupStatusSchema, type SetupState } from '@remote-webos-tv/contracts';

import type { AppConfig } from './config.js';
import { registerAuthRoutes, type AuthRoutesDependencies } from './auth/routes.js';
import { installAuthRateLimit } from './security/rate-limit.js';
import { safeCauseTypes, safeLoggerOptions } from './security/logging.js';
import { httpPolicy } from './security/http-policy.js';
import type { TvService } from './tv/service.js';
import { registerTvRoutes } from './tv/routes.js';
import { createTvAttemptLimiter } from './tv/rate-limit.js';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly getSetupState: () => Promise<SetupState>;
  readonly webRoot?: string;
  readonly auth?: Omit<AuthRoutesDependencies, 'config'>;
  readonly tv?: TvService;
  readonly reportError?: (report: { readonly requestId: string; readonly status: number; readonly causeTypes: readonly string[] }) => void;
  readonly logStream?: Writable;
}

class StorageUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Storage unavailable', { cause });
    this.name = 'StorageUnavailableError';
  }
}

function routingError(error: Error & { code?: string }, request: FastifyRequest, reply: FastifyReply): void {
  // Router failures run before ordinary hooks and must not echo the raw URL.
  const badRequest = error.code === 'FST_ERR_BAD_URL' || error.code === 'FST_ERR_MAX_PARAM_LENGTH';
  reply.header('x-request-id', request.id).header('cache-control', 'no-store')
    .code(badRequest ? 400 : 500).send({
      code: badRequest ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
      message: badRequest ? 'Bad request' : 'Internal server error', requestId: request.id,
    });
}

export function buildApp({ config, getSetupState, webRoot, auth, tv, reportError, logStream }: AppDependencies) {
  const app = Fastify({
    logger: safeLoggerOptions(logStream),
    bodyLimit: 16 * 1024,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: config.trustedProxy.length ? [...config.trustedProxy] : false,
    frameworkErrors: routingError,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (httpPolicy(request).api) {
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
    const code = storageUnavailable ? 'STORAGE_UNAVAILABLE' : tooLarge ? 'PAYLOAD_TOO_LARGE' : status === 429 ? 'RATE_LIMITED' : status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
    const message = storageUnavailable ? 'Storage unavailable' : tooLarge ? 'Payload too large' : status === 429 ? 'Too many requests' : status < 500 ? 'Bad request' : 'Internal server error';
    if (status >= 500) {
      const report = { requestId: request.id, status, causeTypes: safeCauseTypes(error) };
      app.log.error({ code, ...report }, 'API request failed');
      try {
        reportError?.(report);
      } catch {
        console.error('API diagnostic sink failed');
      }
    }
    reply.code(status).send({ code, message, requestId: request.id });
  });

  if (webRoot) {
    app.register(fastifyStatic, { root: webRoot, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    if (webRoot && httpPolicy(request).spaNavigation) {
      return reply.code(200).type('text/html').sendFile('index.html');
    }
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

  if (auth) {
    installAuthRateLimit(app);
    registerAuthRoutes(app, { config, ...auth });
  }
  if (tv) {
    if (!auth) throw new Error('TV routes require owner authentication');
    registerTvRoutes(app, { service: tv, beforeTvAttempt: createTvAttemptLimiter(app) });
  }

  return app;
}
