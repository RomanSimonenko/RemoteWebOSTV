import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { httpPolicy } from './http-policy.js';

export function installAuthRateLimit(app: FastifyInstance): void {
  app.register(rateLimit, {
    global: false,
    hook: 'onRequest',
    max: 5,
    timeWindow: 60_000,
    cache: 10_000,
    errorResponseBuilder: () => ({ statusCode: 429, code: 'RATE_LIMITED' }),
  });
  app.addHook('onRequest', async (request, reply) => {
    if (httpPolicy(request).authAttempt) {
      await app.rateLimit().call(app, request, reply);
    }
  });
}
