import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { startTvOperationSchema, tvOperationSchema, tvStatusResponseSchema } from '@remote-webos-tv/contracts';
import { projectTvError, TvServiceError, type TvService } from './service.js';

export interface TvRoutesDependencies {
  readonly service: TvService;
  readonly beforeTvAttempt: (request: FastifyRequest, reply: FastifyReply) => Promise<(() => Promise<void>) | undefined>;
}

export function registerTvRoutes(app: FastifyInstance, { service, beforeTvAttempt }: TvRoutesDependencies): void {
  let admission = Promise.resolve();
  const safeFailure = (cause: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (!(cause instanceof TvServiceError)) throw cause;
    return reply.code(cause.statusCode).send({ ...projectTvError(cause), requestId: request.id });
  };
  app.get('/api/tv', async () => tvStatusResponseSchema.parse(await service.status()));
  app.post('/api/tv/operations', async (request, reply) => {
    const parsed = startTvOperationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_REQUEST', message: 'Bad request', requestId: request.id });
    const previous = admission;
    let release!: () => void;
    admission = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      service.assertCanStart(parsed.data);
      const charge = await beforeTvAttempt(request, reply);
      if (!charge) return reply;
      const operation = service.start(parsed.data);
      await charge();
      return reply.code(202).send(tvOperationSchema.parse(operation));
    } catch (cause) { return safeFailure(cause, request, reply); }
    finally { release(); }
  });
  app.post<{ Params: { id: string } }>('/api/tv/operations/:id/cancel', async (request, reply) => {
    if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length !== 0)) {
      return reply.code(400).send({ code: 'BAD_REQUEST', message: 'Bad request', requestId: request.id });
    }
    try { return reply.code(200).send(tvOperationSchema.parse(service.cancel(request.params.id))); }
    catch (cause) { return safeFailure(cause, request, reply); }
  });
}
