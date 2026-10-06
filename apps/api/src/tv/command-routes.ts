import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { tvCommandRequestSchema, tvCommandResultSchema, tvRemoteStateSchema, type TvCommandResult } from '@remote-webos-tv/contracts';
import type { AuthSessionService } from '../auth/sessions.js';
import type { TvService } from './service.js';
import { rejectTvCommand, TvCommandAdmissionError } from './commands.js';

export interface TvCommandRoutesDependencies {
  readonly service: TvService;
  readonly sessions: AuthSessionService;
  readonly sessionForRequest: (request: FastifyRequest) => string | undefined;
  readonly beforeCommandAttempt: (request: FastifyRequest, reply: FastifyReply, commandId: string) => Promise<(() => Promise<void>) | undefined>;
}

function resultStatus(result: TvCommandResult): number {
  if (result.outcome === 'sent') return 200;
  if (result.outcome === 'unknown') return 504;
  switch (result.error.code) {
    case 'TV_UNAVAILABLE': case 'TV_BUSY': return 409;
    case 'UNSUPPORTED_CAPABILITY': case 'APP_NOT_AVAILABLE': return 422;
    case 'COMMAND_NOT_SENT': case 'APP_LIST_UNAVAILABLE': return 503;
    case 'RATE_LIMITED': return 429;
  }
}

export function registerTvCommandRoutes(app: FastifyInstance, { service, sessions, sessionForRequest, beforeCommandAttempt }: TvCommandRoutesDependencies): void {
  let admission = Promise.resolve();
  let closing = false;
  const owned = new Map<AbortController, string>();
  const unsubscribe = sessions.onRevoke((token) => {
    for (const [controller, owner] of owned) if (owner === token) controller.abort();
  });
  // Fastify drains HTTP requests before onClose. Cancel here so that draining
  // cannot wait for a command whose HTTP caller is still waiting for its result.
  app.addHook('preClose', async () => {
    closing = true;
    for (const controller of owned.keys()) controller.abort();
    // A disconnected caller can still be inside an asynchronous limiter peek.
    // Settle that admission before runtime onClose disposes session storage.
    await admission;
  });
  app.addHook('onClose', async () => { unsubscribe(); });
  app.get('/api/tv/remote', async () => tvRemoteStateSchema.parse(service.remoteState()));
  app.post('/api/tv/commands', async (request, reply) => {
    const parsed = tvCommandRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_REQUEST', message: 'Bad request', requestId: request.id });
    if (closing) return reply.code(503).send(rejectTvCommand(parsed.data.id, 'COMMAND_NOT_SENT'));
    const token = sessionForRequest(request);
    const unauthorized = () => reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: request.id });
    if (!token) return unauthorized();
    const controller = new AbortController();
    owned.set(controller, token);
    const abort = () => controller.abort();
    const responseClosed = () => { if (!reply.raw.writableFinished) abort(); };
    request.raw.once('aborted', abort);
    reply.raw.once('close', responseClosed);
    if (request.raw.aborted || closing) abort();
    const respond = (result: TvCommandResult) => reply.code(resultStatus(result)).send(tvCommandResultSchema.parse(result));
    try {
      const previous = admission;
      let release!: () => void;
      admission = new Promise<void>((resolve) => { release = resolve; });
      let pending: Promise<TvCommandResult>;
      try {
        await previous;
        if (!sessions.authenticate(token)) return unauthorized();
        if (controller.signal.aborted) return respond(rejectTvCommand(parsed.data.id, 'COMMAND_NOT_SENT'));
        service.assertCanSendCommand(parsed.data);
        const charge = await beforeCommandAttempt(request, reply, parsed.data.id);
        if (!charge) return reply;
        // Peek can yield: logout and lifecycle changes still own admission.
        if (!sessions.authenticate(token)) return unauthorized();
        if (controller.signal.aborted) return respond(rejectTvCommand(parsed.data.id, 'COMMAND_NOT_SENT'));
        service.assertCanSendCommand(parsed.data);
        pending = service.sendCommand(parsed.data, controller.signal);
        await charge();
      } catch (cause) {
        if (!(cause instanceof TvCommandAdmissionError)) throw cause;
        return respond(rejectTvCommand(parsed.data.id, cause.code));
      } finally { release(); }
      // Only admission is serialized. The next request observes the service's
      // busy gate while this one waits, and never queues behind command work.
      return respond(await pending);
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', responseClosed);
      owned.delete(controller);
    }
  });
}
