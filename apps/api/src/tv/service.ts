import { startTvOperationSchema, tvCommandRequestSchema, tvIdentitySchema, tvSnapshotSchema, type StartTvOperation, type TvCommandRequest, type TvCommandResult, type TvConnectionState, type TvOperation, type TvRemoteState, type TvStatusResponse } from '@remote-webos-tv/contracts';
import { WebOsError, type ClientKeyCipher, type ClientKeyStore, type EncryptedEnvelopeV1, type WebOsAdapter } from '@remote-webos-tv/webos';
import type { StoredTv, TvRepository } from './repository.js';
import { createStagingKeyStore } from './staging-key-store.js';
import { abortable, cleanupFailure, failedConnection, projectTvError, TvServiceError, type PublicTvError } from './operation.js';
import { executeTvCommand, rejectTvCommand, TvCommandAdmissionError, unknownTvCommand } from './commands.js';

export { TvServiceError, projectTvError } from './operation.js';
export { TvCommandAdmissionError } from './commands.js';
export interface TvScheduler {
  /** Monotonic milliseconds, independent of the epoch clock used by the UI. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface TvServiceDependencies {
  readonly repository: TvRepository;
  readonly cipher: {
    decrypt: ClientKeyCipher['decrypt'];
    encrypt(key: string): EncryptedEnvelopeV1 | Promise<EncryptedEnvelopeV1>;
  };
  readonly createAdapter: (host: string, staging: ClientKeyStore, requestTimeoutMs: number, allowPairingPrompt: boolean) => WebOsAdapter;
  readonly now: () => number;
  readonly newId: () => string;
  readonly scheduler: TvScheduler;
}
export interface TvService {
  remoteState(): TvRemoteState;
  assertCanSendCommand(input: TvCommandRequest): TvCommandRequest;
  sendCommand(input: TvCommandRequest, signal: AbortSignal): Promise<TvCommandResult>;
  assertCanStart(input: StartTvOperation): StartTvOperation;
  start(input: StartTvOperation): TvOperation;
  status(): Promise<TvStatusResponse>;
  cancel(id: string): TvOperation;
  initialize(): Promise<void>;
  close(): Promise<void>;
}

const operationBudgetMs = 60_000;
const statusBudgetMs = 5_000;
const commandBudgetMs = 5_000;
interface Attempt {
  operation: TvOperation;
  readonly controller: AbortController;
  readonly expiresAt: number;
  readonly timer: unknown;
}
interface Probe { readonly controller: AbortController; readonly promise: Promise<void> }
interface Cleanup { readonly adapter: WebOsAdapter; readonly promise: Promise<void> }
interface Command { readonly controller: AbortController; readonly promise: Promise<TvCommandResult> }

export function createTvService(dependencies: TvServiceDependencies): TvService {
  const { repository, cipher, scheduler } = dependencies;
  let saved = repository.load();
  let connection: TvConnectionState = saved ? 'unavailable' : 'unconfigured';
  let error: PublicTvError | undefined;
  let attempt: Attempt | undefined;
  let work: Promise<void> | undefined;
  let activeAdapter: WebOsAdapter | undefined;
  let probe: Probe | undefined;
  let cleanup: Cleanup | undefined;
  let command: Command | undefined;
  let remoteCapability: { readonly generation: number; readonly pointer: boolean } | undefined;
  let generation = 0;
  let initialized = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let unsafeCleanup: unknown;

  const view = (): TvStatusResponse => ({
    tv: saved ? { host: saved.host, identity: { ...saved.identity } } : null,
    connection,
    operation: attempt ? copyOperation(attempt.operation) : null,
    ...(error ? { error: { ...error } } : {}),
  });

  function disconnect(adapter: WebOsAdapter): Promise<void> {
    if (cleanup?.adapter === adapter) return cleanup.promise;
    if (activeAdapter === adapter) { activeAdapter = undefined; remoteCapability = undefined; }
    const pending = Promise.resolve().then(() => adapter.disconnect()).catch((cause: unknown) => {
      unsafeCleanup = new TvServiceError('CLEANUP_FAILED', 500, { cause });
      throw unsafeCleanup;
    });
    const current: Cleanup = { adapter, promise: pending.finally(() => { if (cleanup === current) cleanup = undefined; }) };
    cleanup = current;
    return current.promise;
  }

  function check(context: Attempt): void {
    if (attempt !== context || closed) throw new TvServiceError('CANCELLED');
    if (unsafeCleanup) throw unsafeCleanup;
    if (!context.controller.signal.aborted && scheduler.now() >= context.expiresAt) {
      context.controller.abort(new WebOsError('PAIRING_TIMEOUT', 'TV operation budget expired'));
    }
    if (context.controller.signal.aborted) throw context.controller.signal.reason;
  }

  async function run(context: Attempt, input: StartTvOperation, previous: StoredTv | null): Promise<void> {
    // Own the old connection before any abortable await: an early abort while
    // waiting for its probe must still disconnect it before releasing the gate.
    const previousAdapter = activeAdapter;
    let adapter: WebOsAdapter | undefined;
    let previousCleanup: Promise<void> | undefined;
    const signal = context.controller.signal;
    try {
      if (probe) { probe.controller.abort(new TvServiceError('CANCELLED')); await abortable(probe.promise, signal); }
      if (cleanup) { previousCleanup = cleanup.promise; await abortable(previousCleanup, signal); }
      if (activeAdapter) { previousCleanup = disconnect(activeAdapter); await abortable(previousCleanup, signal); }
      check(context);
      const host = 'host' in input ? input.host : previous!.host;
      const allowPrompt = input.action === 'pair' || input.action === 'repair';
      const initialKey = allowPrompt ? undefined : cipher.decrypt(previous!.encryptedClientKey);
      const staging = createStagingKeyStore(initialKey);
      adapter = dependencies.createAdapter(host, staging, Math.max(1, context.expiresAt - scheduler.now()), allowPrompt);
      activeAdapter = adapter;
      const result = await abortable(adapter.pair({ host, signal, ...(initialKey === undefined ? {} : { clientKey: initialKey }) }), signal);
      check(context);
      if (!result.clientKey) throw new WebOsError('INVALID_TV_RESPONSE', 'Registered response lacks a client key');
      const identity = tvIdentitySchema.strict().safeParse(result.identity);
      if (!identity.success) throw new WebOsError('INVALID_TV_RESPONSE', 'Registration identity is invalid');
      const snapshot = await abortable(adapter.readSnapshot(signal), signal);
      check(context);
      if (!tvSnapshotSchema.safeParse(snapshot).success || snapshot.connection !== 'available') {
        throw new WebOsError('INVALID_TV_RESPONSE', 'Snapshot did not confirm availability');
      }
      const identityChanged = previous?.identity.model !== identity.data.model
        || previous.identity.platformVersion !== identity.data.platformVersion
        || previous.identity.firmwareVersion !== identity.data.firmwareVersion;
      if (input.action !== 'reconnect' || initialKey !== result.clientKey || identityChanged) {
        let encryptedClientKey: EncryptedEnvelopeV1;
        try { encryptedClientKey = await abortable(Promise.resolve(cipher.encrypt(result.clientKey)), signal); }
        catch (cause) { if (signal.aborted) throw signal.reason; if (cause instanceof WebOsError) throw cause; throw new WebOsError('KEY_STORE_WRITE_FAILED', 'Unable to encrypt the registered key', { cause }); }
        const replacement: StoredTv = { host, identity: identity.data, encryptedClientKey };
        check(context);
        // Synchronous replace is the commit point: no await between check and commit.
        try { repository.replace(replacement); }
        catch (cause) { throw new TvServiceError('STORAGE_FAILED', 500, { cause }); }
        saved = replacement;
      }
      context.operation = { ...context.operation, status: 'succeeded' };
      connection = 'available'; error = undefined;
      remoteCapability = { generation, pointer: snapshot.capabilities.pointer === true };
    } catch (cause) {
      const failure = signal.aborted ? signal.reason : cause;
      const failureVersion = generation;
      const publishFailure = (reason: unknown) => {
        if (attempt !== context || generation !== failureVersion) return;
        const cancelled = context.operation.status === 'cancelled' || (reason instanceof TvServiceError && reason.code === 'CANCELLED');
        error = projectTvError(reason);
        context.operation = { ...context.operation, status: cancelled ? 'cancelled' : 'failed', error };
        connection = cancelled ? (saved ? 'unavailable' : 'unconfigured') : failedConnection(reason);
      };
      // Terminal publication has the operation budget; cleanup remains owned and
      // blocks reuse independently, even when disconnect ignores cancellation.
      publishFailure(failure);
      const pendingCleanup = adapter
        ? disconnect(adapter)
        : previousCleanup ?? (previousAdapter ? disconnect(previousAdapter) : undefined);
      if (pendingCleanup) {
        try { await pendingCleanup; }
        catch (cleanupCause) { publishFailure(cleanupFailure(failure, cleanupCause)); }
      }
    } finally { scheduler.clearTimeout(context.timer); }
  }

  function assertCanStart(input: StartTvOperation): StartTvOperation {
    if (closed) throw new TvServiceError('SERVICE_CLOSED', 409);
    if (unsafeCleanup) throw new TvServiceError('CLEANUP_FAILED', 409, { cause: unsafeCleanup });
    if (work || cleanup || command) throw new TvServiceError('OPERATION_CONFLICT', 409);
    const parsed = startTvOperationSchema.safeParse(input);
    if (!parsed.success) throw new TvServiceError('INVALID_REQUEST', 400);
    input = parsed.data;
    if ((input.action === 'pair') !== (saved === null)) throw new TvServiceError('INVALID_ACTION', 409);
    return input;
  }

  function start(input: StartTvOperation): TvOperation {
    input = assertCanStart(input);
    const startedAt = dependencies.now();
    const controller = new AbortController();
    const operation: TvOperation = { id: dependencies.newId(), action: input.action, status: 'running', startedAt, deadlineAt: startedAt + operationBudgetMs };
    const timer = scheduler.setTimeout(() => controller.abort(new WebOsError('PAIRING_TIMEOUT', 'TV operation budget expired')), operationBudgetMs);
    const context: Attempt = { operation, controller, timer, expiresAt: scheduler.now() + operationBudgetMs };
    attempt = context; generation++;
    remoteCapability = undefined;
    connection = input.action === 'pair' || input.action === 'repair' ? 'pairing' : 'connecting';
    error = undefined;
    probe?.controller.abort(new TvServiceError('CANCELLED'));
    // Defer the worker so the synchronous start always publishes the accepted operation first.
    work = Promise.resolve().then(() => run(context, input, saved)).finally(() => { work = undefined; });
    return copyOperation(operation);
  }

  function cancel(id: string): TvOperation {
    if (!attempt || attempt.operation.id !== id) throw new TvServiceError('OPERATION_NOT_FOUND', 404);
    if (attempt.operation.status === 'running') {
      const cancelled = new TvServiceError('CANCELLED');
      attempt.operation = { ...attempt.operation, status: 'cancelled', error: projectTvError(cancelled) };
      attempt.controller.abort(cancelled); generation++;
    }
    return copyOperation(attempt.operation);
  }

  async function readStatus(adapter: WebOsAdapter, controller: AbortController, version: number): Promise<void> {
    const expiresAt = scheduler.now() + statusBudgetMs;
    const timer = scheduler.setTimeout(() => controller.abort(new WebOsError('CONNECTION_LOST', 'TV status read budget expired')), statusBudgetMs);
    try {
      const snapshot = await abortable(adapter.readSnapshot(controller.signal), controller.signal);
      if (scheduler.now() >= expiresAt) controller.abort(new WebOsError('CONNECTION_LOST', 'TV status read budget expired'));
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!tvSnapshotSchema.safeParse(snapshot).success || snapshot.connection !== 'available') throw new WebOsError('INVALID_TV_RESPONSE', 'Snapshot did not confirm availability');
      if (!closed && generation === version) { connection = 'available'; error = undefined; remoteCapability = { generation: version, pointer: snapshot.capabilities.pointer === true }; }
    } catch (cause) {
      // A new operation/close owns cleanup after its cancellation; the old probe cannot publish.
      if (!closed && generation === version) {
        const failure = controller.signal.aborted ? controller.signal.reason : cause;
        connection = failedConnection(failure); error = projectTvError(failure);
        // GET resolves on its own budget. The service still owns and awaits this
        // tracked cleanup on shutdown, and start rejects while it is pending.
        void disconnect(adapter).catch((cleanupCause: unknown) => {
          if (!closed && generation === version) error = projectTvError(cleanupFailure(failure, cleanupCause));
        });
      }
    } finally { scheduler.clearTimeout(timer); }
  }

  async function status(): Promise<TvStatusResponse> {
    if (!closed && !work && !command && activeAdapter) {
      if (!probe) {
        const controller = new AbortController();
        const pending = readStatus(activeAdapter, controller, generation);
        const current: Probe = { controller, promise: pending.finally(() => { if (probe === current) probe = undefined; }) };
        probe = current;
      }
      await probe.promise;
    }
    return view();
  }

  function remoteState(): TvRemoteState {
    // A probe can disconnect the adapter on failure, so it owns the same gate.
    if (work || cleanup || command || probe) return { enabled: false, reason: 'BUSY' };
    if (closed || unsafeCleanup || connection !== 'available' || !activeAdapter || remoteCapability?.generation !== generation) return { enabled: false, reason: 'UNAVAILABLE' };
    if (remoteCapability.pointer !== true) return { enabled: false, reason: 'UNSUPPORTED' };
    return { enabled: true, reason: null };
  }

  function assertCanSendCommand(input: TvCommandRequest): TvCommandRequest {
    const parsed = tvCommandRequestSchema.safeParse(input);
    if (!parsed.success) throw new TvServiceError('INVALID_REQUEST', 400);
    const state = remoteState();
    if (!state.enabled) throw new TvCommandAdmissionError(state.reason === 'BUSY' ? 'TV_BUSY' : state.reason === 'UNSUPPORTED' ? 'UNSUPPORTED_CAPABILITY' : 'TV_UNAVAILABLE');
    return parsed.data;
  }

  async function sendCommand(input: TvCommandRequest, signal: AbortSignal): Promise<TvCommandResult> {
    try { input = assertCanSendCommand(input); }
    catch (cause) {
      if (cause instanceof TvCommandAdmissionError) return rejectTvCommand(input.id, cause.code);
      throw cause;
    }
    const adapter = activeAdapter!;
    const version = generation;
    const controller = new AbortController();
    const expiresAt = scheduler.now() + commandBudgetMs;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const expire = () => controller.abort(new WebOsError('CONNECTION_LOST', 'TV command budget expired'));
    const timer = scheduler.setTimeout(expire, commandBudgetMs);
    let started = false;
    // Acquire ownership synchronously; cancellation before this worker runs is
    // proven not_sent. Once adapter work starts, an unsettled cancellation is unknown.
    const pending = Promise.resolve().then(async () => {
      if (closed || version !== generation || controller.signal.aborted) return rejectTvCommand(input.id, 'COMMAND_NOT_SENT');
      if (scheduler.now() >= expiresAt) { expire(); return rejectTvCommand(input.id, 'COMMAND_NOT_SENT'); }
      started = true;
      const result = await executeTvCommand(input, adapter, controller.signal);
      if (scheduler.now() >= expiresAt && !controller.signal.aborted) expire();
      if (controller.signal.aborted && result.outcome === 'sent') return unknownTvCommand(input.id);
      if (!closed && version === generation && result.outcome === 'rejected' && result.error.code === 'UNSUPPORTED_CAPABILITY') remoteCapability = { generation: version, pointer: false };
      return result;
    });
    const current: Command = { controller, promise: pending.finally(() => {
      scheduler.clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (command === current) command = undefined;
    }) };
    command = current;
    // Cancellation bounds the caller, but cannot release adapter ownership while
    // an implementation ignoring AbortSignal still has unfinished work.
    try { return await abortable(current.promise, controller.signal); }
    catch (cause) {
      if (!controller.signal.aborted) throw cause;
      return started ? unknownTvCommand(input.id) : rejectTvCommand(input.id, 'COMMAND_NOT_SENT');
    }
  }

  async function initialize(): Promise<void> {
    if (initialized || closed) return;
    initialized = true;
    if (saved && !work) start({ action: 'reconnect' });
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; generation++;
    if (attempt?.operation.status === 'running') cancel(attempt.operation.id);
    probe?.controller.abort(new TvServiceError('CANCELLED'));
    command?.controller.abort(new TvServiceError('CANCELLED'));
    closing = (async () => {
      await command?.promise;
      await work; await probe?.promise;
      await cleanup?.promise;
      if (activeAdapter) await disconnect(activeAdapter);
      if (unsafeCleanup) throw unsafeCleanup;
    })();
    return closing;
  }
  return { assertCanStart, start, status, cancel, initialize, close, remoteState, assertCanSendCommand, sendCommand };
}

function copyOperation(operation: TvOperation): TvOperation {
  return { ...operation, ...(operation.error ? { error: { ...operation.error } } : {}) };
}
