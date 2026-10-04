import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { startTvOperationSchema, tvOperationSchema, tvStatusResponseSchema } from '@remote-webos-tv/contracts';
import { projectTvError, TvServiceError, type TvService } from './service.js';
import type { AuthSessionService } from '../auth/sessions.js';

export interface TvRoutesDependencies {
  readonly service: TvService;
  readonly sessions: AuthSessionService;
  readonly sessionForRequest: (request: FastifyRequest) => string | undefined;
  readonly beforeTvAttempt: (request: FastifyRequest, reply: FastifyReply) => Promise<(() => Promise<void>) | undefined>;
}

export function registerTvRoutes(app: FastifyInstance, { service, sessions, sessionForRequest, beforeTvAttempt }: TvRoutesDependencies): void {
  let admission = Promise.resolve();
  let closing = false;
  app.addHook('preClose', async () => { closing = true; await admission; });
  const safeFailure = (cause: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (!(cause instanceof TvServiceError)) throw cause;
    return reply.code(cause.statusCode).send({ ...projectTvError(cause), requestId: request.id });
  };
  app.get('/api/tv', async () => tvStatusResponseSchema.parse(await service.status()));
  app.post('/api/tv/operations', async (request, reply) => {
    const parsed = startTvOperationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_REQUEST', message: 'Bad request', requestId: request.id });
    const token = sessionForRequest(request);
    const unauthorized = () => reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: request.id });
    if (!token) return unauthorized();
    const previous = admission;
    let release!: () => void;
    admission = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!sessions.authenticate(token)) return unauthorized();
      if (closing) throw new TvServiceError('SERVICE_CLOSED', 409);
      service.assertCanStart(parsed.data);
      const charge = await beforeTvAttempt(request, reply);
      if (!charge) return reply;
      if (!sessions.authenticate(token)) return unauthorized();
      if (closing) throw new TvServiceError('SERVICE_CLOSED', 409);
      service.assertCanStart(parsed.data);
      const operation = service.start(parsed.data, parsed.data.action === 'reconnect' ? token : undefined);
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
