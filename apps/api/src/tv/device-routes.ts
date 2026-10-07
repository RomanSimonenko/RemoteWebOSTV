import { addTvRequestSchema, addTvResponseSchema, tvDevicesResponseSchema, tvIdSchema } from '@remote-webos-tv/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthSessionService } from '../auth/sessions.js';
import type { TvDeviceRegistry } from './device-registry.js';
import { TvServiceError, type TvService } from './service.js';
import type { TvSetupAdmission } from './rate-limit.js';

export function addressedTvService(registry: TvDeviceRegistry, request: FastifyRequest): TvService {
  const params = request.params as { tvId?: unknown };
  if (params.tvId === undefined) return registry.legacy();
  const parsed = tvIdSchema.safeParse(params.tvId);
  if (!parsed.success) throw new TvServiceError('INVALID_REQUEST', 400);
  const service = registry.get(parsed.data);
  if (!service) throw new TvServiceError('TV_NOT_FOUND', 404);
  return service;
}

export function registerTvDeviceRoutes(app: FastifyInstance, dependencies: {
  registry: TvDeviceRegistry; sessions: AuthSessionService;
  admission: TvSetupAdmission;
  sessionForRequest(request: FastifyRequest): string | undefined;
  beforeTvAttempt(request: FastifyRequest, reply: FastifyReply): Promise<(() => Promise<void>) | undefined>;
}) {
  const { registry, sessions, sessionForRequest, beforeTvAttempt, admission } = dependencies;
  let closing = false;
  app.addHook('preClose', async () => { closing = true; await admission.pending; });
  app.get('/api/tvs', async () => tvDevicesResponseSchema.parse({ devices: await registry.list() }));
  app.post('/api/tvs', async (request, reply) => {
    const parsed = addTvRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new TvServiceError('INVALID_REQUEST', 400);
    const owner = sessionForRequest(request);
    const unauthorized = () => reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: request.id });
    if (!owner) return unauthorized();
    const previous = admission.pending; let release!: () => void; admission.pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!sessions.authenticate(owner)) return unauthorized();
      if (closing) throw new TvServiceError('SERVICE_CLOSED', 409);
      const replay = registry.assertCanAdd(parsed.data, owner);
      if (replay) return reply.code(202).send(addTvResponseSchema.parse(replay));
      const charge = await beforeTvAttempt(request, reply); if (!charge) return reply;
      if (!sessions.authenticate(owner)) return unauthorized();
      if (closing) throw new TvServiceError('SERVICE_CLOSED', 409);
      const acceptedDuringWait = registry.assertCanAdd(parsed.data, owner);
      if (acceptedDuringWait) return reply.code(202).send(addTvResponseSchema.parse(acceptedDuringWait));
      const result = registry.add(parsed.data, owner); await charge();
      return reply.code(202).send(addTvResponseSchema.parse(result));
    } finally { release(); }
  });
}
