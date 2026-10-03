import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** The sole owner has one budget, independent of source address or session. */
export function createTvAttemptLimiter(app: FastifyInstance) {
  let limiter: ReturnType<FastifyInstance['createRateLimit']> | undefined;
  return async (request: FastifyRequest, reply: FastifyReply): Promise<(() => Promise<void>) | undefined> => {
    limiter ??= app.createRateLimit({ max: 5, timeWindow: 60_000, keyGenerator: () => 'tv-owner' });
    const state = await limiter(request, { increment: false });
    if (!state.isAllowed && state.remaining === 0) {
      reply.header('retry-after', state.ttlInSeconds).code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests', requestId: request.id });
      return undefined;
    }
    // Routes serialize peek, synchronous service admission and this accepted charge.
    return async () => { await limiter!(request); };
  };
}
