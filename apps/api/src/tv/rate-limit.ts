import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { rejectTvCommand } from './commands.js';

function createAcceptedAttemptLimiter(app: FastifyInstance, options: { max: number; timeWindow: number; key: string }) {
  let limiter: ReturnType<FastifyInstance['createRateLimit']> | undefined;
  return async (request: FastifyRequest, reply: FastifyReply, limitedResponse: () => unknown): Promise<(() => Promise<void>) | undefined> => {
    limiter ??= app.createRateLimit({ max: options.max, timeWindow: options.timeWindow, keyGenerator: () => options.key });
    const state = await limiter(request, { increment: false });
    if (!state.isAllowed && state.remaining === 0) {
      reply.header('retry-after', state.ttlInSeconds).code(429).send(limitedResponse());
      return undefined;
    }
    // Routes serialize peek, synchronous service admission and accepted charge.
    return async () => { await limiter!(request); };
  };
}

/** The sole owner has one budget, independent of source address or session. */
export function createTvAttemptLimiter(app: FastifyInstance) {
  const limiter = createAcceptedAttemptLimiter(app, { max: 5, timeWindow: 60_000, key: 'tv-owner' });
  return (request: FastifyRequest, reply: FastifyReply) => limiter(request, reply, () => ({ code: 'RATE_LIMITED', message: 'Too many requests', requestId: request.id }));
}

export function createTvCommandLimiter(app: FastifyInstance) {
  const limiter = createAcceptedAttemptLimiter(app, { max: 10, timeWindow: 1000, key: 'tv-command-owner' });
  return (request: FastifyRequest, reply: FastifyReply, commandId: string) => limiter(request, reply, () => rejectTvCommand(commandId, 'RATE_LIMITED'));
}
