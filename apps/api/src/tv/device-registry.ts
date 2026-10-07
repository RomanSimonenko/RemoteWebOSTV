import { addTvRequestSchema, tvIdSchema, type AddTvRequest, type AddTvResponse, type TvDevice, type TvId, type TvOperation, type StartTvOperation } from '@remote-webos-tv/contracts';
import type { TvDeviceRepository, TvRepository } from './repository.js';
import { TvServiceError, type TvScheduler, type TvService } from './service.js';

export interface TvDeviceRegistry {
  list(): Promise<TvDevice[]>;
  get(tvId: TvId): TvService | null;
  add(request: AddTvRequest, owner: string): AddTvResponse;
  assertCanAdd(request: AddTvRequest, owner: string): AddTvResponse | null;
  legacy(): TvService;
  initialize(): Promise<void>;
  revoke(owner: string): Promise<void>;
  close(): Promise<void>;
}
interface Receipt { readonly request: AddTvRequest; readonly tvId: TvId; operation: TvOperation; expired: boolean }
interface Entry { readonly service: TvService; owner?: string; timer?: unknown; disposal?: Promise<void> }
const draftRetentionMs = 600_000;
const receiptCapacity = 100;

export function createTvDeviceRegistry(dependencies: {
  repository: TvDeviceRepository;
  scheduler: TvScheduler;
  newId(): string;
  createService(repository: TvRepository, onFinished: (operation: TvOperation) => void): TvService;
}): TvDeviceRegistry {
  const { repository, scheduler } = dependencies;
  const entries = new Map<TvId, Entry>();
  const reservedHosts = new Map<string, TvId>();
  const receipts = new Map<string, Map<string, Receipt>>();
  const pendingClosures = new Set<Promise<void>>();
  const cleanupFailures: unknown[] = [];
  let legacyId = repository.legacyId();
  let closing: Promise<void> | undefined;
  let closed = false;

  function checkHost(host: string, tvId?: TvId) {
    const reserved = reservedHosts.get(host);
    if (reserved) {
      const entry = entries.get(reserved);
      // Terminal publication can precede transport cleanup. Only the owning
      // service's idle gate proves this pending address can be used again.
      if (entry && !entry.disposal && !entry.service.powerState().busy) reservedHosts.delete(host);
    }
    const occupied = repository.hostOwner(host) ?? reservedHosts.get(host);
    if (occupied && occupied !== tvId) throw new TvServiceError('DUPLICATE_TV_HOST', 409);
  }
  function releaseHosts(tvId: TvId) { for (const [host, id] of reservedHosts) if (id === tvId) reservedHosts.delete(host); }
  function dispose(tvId: TvId): Promise<void> {
    const entry = entries.get(tvId);
    if (!entry) return Promise.resolve();
    if (entry.disposal) return entry.disposal;
    if (entry.timer !== undefined) scheduler.clearTimeout(entry.timer);
    // Keep address reservations until the service has finished releasing its adapter.
    const pending = entry.service.close().finally(() => { if (entry.timer !== undefined) scheduler.clearTimeout(entry.timer); releaseHosts(tvId); entries.delete(tvId); });
    entry.disposal = pending;
    pendingClosures.add(pending);
    void pending.then(() => pendingClosures.delete(pending), (cause: unknown) => { pendingClosures.delete(pending); cleanupFailures.push(cause); });
    return pending;
  }
  function ensure(tvId: TvId): TvService {
    const existing = entries.get(tvId); if (existing) return existing.service;
    const scoped = repository.forDevice(tvId);
    const finished = (operation: TvOperation) => {
      for (const owned of receipts.values()) for (const receipt of owned.values()) if (receipt.tvId === tvId && receipt.operation.id === operation.id) receipt.operation = operation;
      const entry = entries.get(tvId);
      if (entry && !closed && !entry.disposal && !scoped.hasStoredKey() && entry.owner && entry.timer === undefined) {
        entry.timer = scheduler.setTimeout(() => {
          for (const owned of receipts.values()) for (const receipt of owned.values()) if (receipt.tvId === tvId) receipt.expired = true;
          void dispose(tvId).catch(() => { /* Failure is retained by dispose and reported at close. */ });
        }, draftRetentionMs);
      }
    };
    const inner = dependencies.createService({ ...scoped, replace(value) { checkHost(value.host, tvId); scoped.replace(value); } }, finished);
    const assertCanStart = (input: StartTvOperation) => {
      if (closed) throw new TvServiceError('SERVICE_CLOSED', 409);
      const parsed = inner.assertCanStart(input); if ('host' in parsed) checkHost(parsed.host, tvId); return parsed;
    };
    const service: TvService = { ...inner, assertCanStart,
      start(input, owner) { const parsed = assertCanStart(input); releaseHosts(tvId); if ('host' in parsed) reservedHosts.set(parsed.host, tvId); try { return inner.start(parsed, owner); } catch (cause) { releaseHosts(tvId); throw cause; } },
    };
    entries.set(tvId, { service }); return service;
  }
  function assertCanAdd(input: AddTvRequest, owner: string): AddTvResponse | null {
    if (closed) throw new TvServiceError('SERVICE_CLOSED', 409);
    const request = addTvRequestSchema.parse(input);
    const owned = receipts.get(owner);
    const previous = owned?.get(request.id);
    if (previous) {
      if (previous.expired) throw new TvServiceError('OPERATION_NOT_FOUND', 404);
      if (previous.request.host !== request.host || previous.request.platform !== request.platform) throw new TvServiceError('OPERATION_CONFLICT', 409);
      return { tvId: previous.tvId, operation: previous.operation };
    }
    if (owned && owned.size >= receiptCapacity) throw new TvServiceError('OPERATION_CONFLICT', 409);
    checkHost(request.host);
    return null;
  }
  return {
    assertCanAdd,
    async list() { return Promise.all(repository.list().map(async ({ tvId, platform }) => ({ tvId, platform, status: await ensure(tvId).status() }))); },
    get(tvId) { if (closed) return null; return entries.get(tvId)?.service ?? (repository.list().some((tv) => tv.tvId === tvId) ? ensure(tvId) : null); },
    add(input, owner) {
      const previous = assertCanAdd(input, owner);
      if (previous) return previous;
      const request = addTvRequestSchema.parse(input);
      const owned = receipts.get(owner) ?? new Map<string, Receipt>();
      const tvId = tvIdSchema.parse(dependencies.newId()); checkHost(request.host, tvId);
      const service = ensure(tvId);
      const operation = service.start({ action: 'pair', host: request.host });
      entries.get(tvId)!.owner = owner;
      owned.set(request.id, { request, tvId, operation, expired: false }); receipts.set(owner, owned);
      return { tvId, operation };
    },
    legacy() { legacyId = repository.legacyId() ?? legacyId ?? tvIdSchema.parse(dependencies.newId()); return ensure(legacyId); },
    async initialize() { for (const { tvId } of repository.list()) await ensure(tvId).initialize(); },
    async revoke(owner) {
      receipts.delete(owner);
      const results = await Promise.allSettled([...entries].map(([tvId, entry]) => entry.owner === owner && !repository.forDevice(tvId).hasStoredKey() ? dispose(tvId) : entry.service.cancelOwnedPower(owner)));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason as unknown);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'TV session cleanup failed');
    },
    close() {
      if (closing) return closing; closed = true;
      closing = (async () => {
        await Promise.allSettled([...entries.keys()].map(dispose));
        await Promise.allSettled([...pendingClosures]); receipts.clear(); reservedHosts.clear();
        if (cleanupFailures.length === 1) throw cleanupFailures[0];
        if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, 'TV registry cleanup failed');
      })(); return closing;
    },
  };
}
