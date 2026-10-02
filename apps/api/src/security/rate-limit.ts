import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

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
    const path = request.url.split('?', 1)[0];
    if (request.method === 'POST' && (path === '/api/setup' || path === '/api/auth/login')) {
      await app.rateLimit().call(app, request, reply);
    }
  });
}
