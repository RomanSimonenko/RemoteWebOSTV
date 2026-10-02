import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loginRequestSchema, setupRequestSchema } from '@remote-webos-tv/contracts';

import type { AppConfig } from '../config.js';
import { OwnerSetupError, type OwnerSetupService } from './service.js';
import type { AuthSessionService } from './sessions.js';
import { httpPolicy } from '../security/http-policy.js';

export interface AuthRoutesDependencies {
  readonly config: AppConfig;
  readonly setup: OwnerSetupService;
  readonly sessions: AuthSessionService;
  readonly beforeAuthAttempt?: (kind: 'setup' | 'login', request: FastifyRequest) => Promise<void>;
}

function sessionCookie(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  const values = header.split(';').map((part) => part.trim());
  const cookies = values.filter((part) => part.startsWith('remote_webos_session='));
  if (cookies.length !== 1) return undefined;
  return cookies[0]!.slice('remote_webos_session='.length);
}

export function registerAuthRoutes(app: FastifyInstance, { config, setup, sessions, beforeAuthAttempt }: AuthRoutesDependencies): void {
  if (config.publicOrigin.startsWith('https://') && !config.secureCookies) {
    throw new Error('Secure cookies are required for an HTTPS public origin');
  }
  const error = (request: FastifyRequest, code: string, message: string) => ({ code, message, requestId: request.id });
  app.addHook('onRequest', async (request, reply) => {
    const policy = httpPolicy(request);
    if (!policy.api) return;
    if (request.is404) return;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutating && request.headers.origin !== config.publicOrigin) {
      reply.code(403).send(error(request, 'FORBIDDEN', 'Forbidden'));
      return;
    }
    if (!policy.requiresSession) return;
    const cookie = sessionCookie(request);
    if (!sessions.authenticate(cookie)) {
      reply.code(401).send(error(request, 'UNAUTHORIZED', 'Unauthorized'));
      return;
    }
    if (mutating && !sessions.verifyCsrf(cookie!, request.headers['x-csrf-token'])) {
      reply.code(403).send(error(request, 'FORBIDDEN', 'Forbidden'));
    }
  });

  app.post('/api/setup', async (request, reply) => {
    if (beforeAuthAttempt) await beforeAuthAttempt('setup', request);
    const parsed = setupRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(error(request, 'BAD_REQUEST', 'Bad request'));
    try {
      await setup.claimOwner(parsed.data);
    } catch (cause) {
      if (cause instanceof OwnerSetupError) {
        const status = cause.code === 'INVALID_OWNER_INPUT' ? 400 : 403;
        return reply.code(status).send(error(request, status === 400 ? 'BAD_REQUEST' : 'FORBIDDEN', status === 400 ? 'Bad request' : 'Forbidden'));
      }
      throw cause;
    }
    return reply.code(201).send();
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (beforeAuthAttempt) await beforeAuthAttempt('login', request);
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(error(request, 'BAD_REQUEST', 'Bad request'));
    const result = await sessions.login(parsed.data.username, parsed.data.password);
    if (!result) return reply.code(401).send(error(request, 'INVALID_CREDENTIALS', 'Invalid credentials'));
    reply.header('set-cookie', `remote_webos_session=${result.token}; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict${config.secureCookies ? '; Secure' : ''}`);
    return reply.code(200).send({ username: result.username });
  });

  app.get('/api/auth/session', async (request, reply) => {
    const identity = sessions.authenticate(sessionCookie(request));
    if (!identity) return reply.code(401).send(error(request, 'UNAUTHORIZED', 'Unauthorized'));
    return identity;
  });

  app.post('/api/auth/logout', async (request, reply) => {
    sessions.revoke(sessionCookie(request)!);
    reply.header('set-cookie', `remote_webos_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${config.secureCookies ? '; Secure' : ''}`);
    return reply.code(204).send();
  });
}
