import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { tvMacAddressSchema, tvPowerOperationSchema, tvPowerRequestSchema, tvPowerStateSchema, type TvPowerOperation, type TvPowerRequest } from '@remote-webos-tv/contracts';
import type { AuthSessionService } from '../auth/sessions.js';
import { projectTvError, TvServiceError, type TvService } from './service.js';

export interface TvPowerRoutesDependencies {
  readonly service: TvService;
  readonly sessions: AuthSessionService;
  readonly sessionForRequest: (request: FastifyRequest) => string | undefined;
  readonly beforePowerAttempt: (request: FastifyRequest, reply: FastifyReply) => Promise<(() => Promise<void>) | undefined>;
}

interface Receipt { readonly action: TvPowerRequest['action']; operation: TvPowerOperation }
const receiptCapacity = 100;

export function registerTvPowerRoutes(app: FastifyInstance, { service, sessions, sessionForRequest, beforePowerAttempt }: TvPowerRoutesDependencies): void {
  let admission = Promise.resolve();
  let closing = false;
  const receipts = new Map<string, Map<string, Receipt>>();
  const failure = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ code, message, requestId: request.id });
  const badRequest = (request: FastifyRequest, reply: FastifyReply) => failure(request, reply, 400, 'BAD_REQUEST', 'Bad request');
  const safeFailure = (cause: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (!(cause instanceof TvServiceError)) throw cause;
    return reply.code(cause.code === 'UNSUPPORTED_CAPABILITY' ? 422 : cause.statusCode).send({ ...projectTvError(cause), requestId: request.id });
  };
  const unsubscribePower = service.onPowerFinished((operation, owner) => {
    if (typeof owner !== 'string') return;
    const receipt = receipts.get(owner)?.get(operation.id);
    if (receipt) receipt.operation = operation;
  });
  const unsubscribe = sessions.onRevoke((token) => {
    receipts.delete(token);
    return service.cancelOwnedPower(token);
  });
  app.addHook('preClose', async () => { closing = true; await admission; });
  app.addHook('onClose', async () => { unsubscribe(); unsubscribePower(); receipts.clear(); });

  app.get('/api/tv/power', async () => tvPowerStateSchema.parse(service.powerState()));
  app.put('/api/tv/mac', async (request, reply) => {
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length !== 1 || !('mac' in body)) return badRequest(request, reply);
    const parsed = tvMacAddressSchema.nullable().safeParse(body.mac);
    if (!parsed.success) return badRequest(request, reply);
    const token = sessionForRequest(request);
    if (!token || !sessions.authenticate(token)) return failure(request, reply, 401, 'UNAUTHORIZED', 'Unauthorized');
    try {
      if (closing) throw new TvServiceError('SERVICE_CLOSED', 409);
      return tvPowerStateSchema.parse(service.setMac(parsed.data));
    }
    catch (cause) { return safeFailure(cause, request, reply); }
  });
  app.post('/api/tv/power', async (request, reply) => {
    const parsed = tvPowerRequestSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(request, reply);
    const token = sessionForRequest(request);
    const unauthorized = () => failure(request, reply, 401, 'UNAUTHORIZED', 'Unauthorized');
    if (!token) return unauthorized();
    const previous = admission;
    let release!: () => void;
    admission = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!sessions.authenticate(token)) return unauthorized();
      if (closing) throw new TvServiceError('SERVICE_CLOSED', 409);
      const owned = receipts.get(token);
      const accepted = owned?.get(parsed.data.id);
      if (accepted) {
        if (accepted.action !== parsed.data.action) throw new TvServiceError('OPERATION_CONFLICT', 409);
        if (accepted.operation.status === 'running') {
          const current = service.powerState().operation;
          if (current?.id === accepted.operation.id) accepted.operation = current;
        }
        return reply.code(202).send(tvPowerOperationSchema.parse(accepted.operation));
      }
      if (owned?.size === receiptCapacity) return failure(request, reply, 409, 'POWER_RECEIPT_CAPACITY', 'Войдите заново, чтобы запустить новую операцию питания.');
      service.assertCanStartPower(parsed.data);
      const charge = await beforePowerAttempt(request, reply);
      if (!charge) return reply;
      // Limiter reads yield. Recheck session and the sole service gate before
      // any send, then record acceptance before the asynchronous charge.
      if (!sessions.authenticate(token)) return unauthorized();
      if (closing) throw new TvServiceError('SERVICE_CLOSED', 409);
      service.assertCanStartPower(parsed.data);
      const operation = service.startPower(parsed.data, token);
      const receipt: Receipt = { action: parsed.data.action, operation };
      const sessionReceipts = owned ?? new Map<string, Receipt>();
      sessionReceipts.set(parsed.data.id, receipt); receipts.set(token, sessionReceipts);
      await charge();
      return reply.code(202).send(tvPowerOperationSchema.parse(operation));
    } catch (cause) { return safeFailure(cause, request, reply); }
    finally { release(); }
  });
  app.post<{ Params: { id: string } }>('/api/tv/power/:id/cancel', async (request, reply) => {
    if (!tvPowerOperationSchema.shape.id.safeParse(request.params.id).success) return badRequest(request, reply);
    if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length !== 0)) return badRequest(request, reply);
    const token = sessionForRequest(request);
    if (!token || !sessions.authenticate(token)) return failure(request, reply, 401, 'UNAUTHORIZED', 'Unauthorized');
    const receipt = receipts.get(token)?.get(request.params.id);
    if (!receipt) return failure(request, reply, 403, 'FORBIDDEN', 'Forbidden');
    try {
      if (receipt.operation.status === 'running') receipt.operation = service.cancelPower(request.params.id, token);
      return tvPowerOperationSchema.parse(receipt.operation);
    } catch (cause) {
      if (cause instanceof TvServiceError && cause.code === 'OPERATION_NOT_FOUND') return failure(request, reply, 403, 'FORBIDDEN', 'Forbidden');
      return safeFailure(cause, request, reply);
    }
  });
}
