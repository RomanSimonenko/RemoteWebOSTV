import { startTvOperationSchema, supportsTvButtons, tvCommandRequestSchema, tvIdentitySchema, tvMacAddressSchema, tvPlatformSchema, tvPowerRequestSchema, tvSnapshotSchema, type StartTvOperation, type TvCommandRequest, type TvCommandResult, type TvConnectionState, type TvOperation, type TvPlatform, type TvPowerOperation, type TvPowerRequest, type TvPowerState, type TvRemoteState, type TvStatusResponse } from '@remote-webos-tv/contracts';
import type { PairingResult, TvAdapter, TvObservedPower } from '@remote-webos-tv/tv-adapter';
import { TvPowerSendError, WebOsError } from '@remote-webos-tv/tv-adapter';
import type { ClientKeyCipher, ClientKeyStore, EncryptedEnvelopeV1 } from '@remote-webos-tv/webos';
import type { StoredTv, TvRepository } from './repository.js';
import { createStagingKeyStore } from './staging-key-store.js';
import { abortable, cleanupFailure, failedConnection, hasCleanupFailure, projectTvError, TvServiceError, type PublicTvError } from './operation.js';
import { executeTvCommand, rejectTvCommand, TvCommandAdmissionError, unknownTvCommand } from './commands.js';
import { isTransientTvFailure, recoveryAttemptBudget, recoveryCooldown, waitForTv } from './recovery.js';

export { TvServiceError, projectTvError } from './operation.js';
export { TvCommandAdmissionError } from './commands.js';
export interface TvScheduler {
  /** Monotonic milliseconds, independent of the epoch clock used by the UI. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface TvServiceDependencies {
  readonly platform?: TvPlatform;
  readonly repository: TvRepository;
  readonly cipher: {
    decrypt: ClientKeyCipher['decrypt'];
    encrypt(key: string): EncryptedEnvelopeV1 | Promise<EncryptedEnvelopeV1>;
  };
  readonly createAdapter: (host: string, staging: ClientKeyStore, requestTimeoutMs: number, allowPairingPrompt: boolean, platform?: TvPlatform) => TvAdapter;
  readonly now: () => number;
  readonly newId: () => string;
  readonly scheduler: TvScheduler;
  readonly recoveryTimeoutMs?: number;
  readonly onVersionDiagnostic?: (diagnostic: TvVersionDiagnostic) => void;
  readonly onOperationFinished?: (operation: TvOperation) => void;
}
export interface TvVersionDiagnostic {
  readonly operation: 'hello' | 'sdb_capability';
  readonly code: 'timeout' | 'invalid_response' | 'version_unavailable' | 'request_rejected' | 'send_failed' | 'read_failed' | 'storage_failed';
}
export interface TvService {
  powerState(): TvPowerState;
  setMac(mac: string | null): TvPowerState;
  assertCanStartPower(input: TvPowerRequest): TvPowerRequest;
  startPower(input: TvPowerRequest, owner: string): TvPowerOperation;
  cancelPower(id: string, owner: string): TvPowerOperation;
  cancelOwnedPower(owner: string): Promise<void>;
  /** Internal synchronous retention of terminal results before state replacement. */
  onPowerFinished(listener: (operation: TvPowerOperation, owner: string | symbol) => void): () => void;
  remoteState(): TvRemoteState;
  assertCanSendCommand(input: TvCommandRequest): TvCommandRequest;
  sendCommand(input: TvCommandRequest, signal: AbortSignal): Promise<TvCommandResult>;
  assertCanStart(input: StartTvOperation): StartTvOperation;
  start(input: StartTvOperation, owner?: string): TvOperation;
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
  readonly power?: Power;
  readonly owner?: string | symbol;
  lastFailure?: unknown;
}
interface Power { operation: TvPowerOperation; readonly owner: string | symbol }
interface Probe { readonly controller: AbortController; readonly promise: Promise<void> }
interface Cleanup { readonly adapter: TvAdapter; readonly promise: Promise<void> }
interface Command { readonly controller: AbortController; readonly promise: Promise<TvCommandResult> }
interface Metadata extends Probe { readonly adapter: TvAdapter }

export function createTvService(dependencies: TvServiceDependencies): TvService {
  const { repository, cipher, scheduler } = dependencies;
  const recoveryTimeoutMs = dependencies.recoveryTimeoutMs ?? 60_000;
  if (!Number.isInteger(recoveryTimeoutMs) || recoveryTimeoutMs < 1_000 || recoveryTimeoutMs > 300_000) throw new Error('Invalid TV recovery timeout');
  let saved = repository.load();
  const platform = tvPlatformSchema.parse(saved?.platform ?? dependencies.platform ?? 'webos');
  let connection: TvConnectionState = saved ? 'unavailable' : 'unconfigured';
  let error: PublicTvError | undefined;
  let attempt: Attempt | undefined;
  let work: Promise<void> | undefined;
  let activeAdapter: TvAdapter | undefined;
  let probe: Probe | undefined;
  let cleanup: Cleanup | undefined;
  let command: Command | undefined;
  let metadata: Metadata | undefined;
  // Samsung SDB metadata is authoritative only for the currently owned session.
  let currentTizenVersion = false;
  let remoteCapability: { readonly generation: number; readonly buttons: boolean; readonly apps: boolean; readonly powerOff: boolean } | undefined;
  let power: Power | undefined;
  let intentionalOff = false;
  let observedPower: 'on' | 'standby' | 'unknown' = 'unknown';
  let recoverAfterProbe = false;
  let recoveryFailure: unknown;
  const serverOwner = Symbol('automatic TV recovery');
  let generation = 0;
  let initialized = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let unsafeCleanup: unknown;
  const powerFinishedListeners = new Set<(operation: TvPowerOperation, owner: string | symbol) => void>();

  const view = (): TvStatusResponse => ({
    tv: saved ? { host: saved.host, identity: platform === 'tizen' && !currentTizenVersion
      ? withoutPlatformVersion(saved.identity) : { ...saved.identity } } : null,
    connection,
    operation: attempt && !attempt.power ? copyOperation(attempt.operation) : null,
    ...(error ? { error: { ...error } } : {}),
  });

  function latchCleanupFailure(cause: unknown): void {
    if (hasCleanupFailure(cause)) unsafeCleanup ??= new TvServiceError('CLEANUP_FAILED', 500, { cause });
  }

  function disconnect(adapter: TvAdapter): Promise<void> {
    if (metadata?.adapter === adapter) metadata.controller.abort(new TvServiceError('CANCELLED'));
    if (cleanup?.adapter === adapter) return cleanup.promise;
    if (activeAdapter === adapter) {
      activeAdapter = undefined; remoteCapability = undefined;
      currentTizenVersion = false;
      // Disposing the owned connection cannot prove physical TV power state.
      if (connection === 'available') connection = 'unavailable';
    }
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
      context.controller.abort(budgetFailure(context));
    }
    if (context.controller.signal.aborted) throw context.controller.signal.reason;
  }

  function budgetFailure(context: Attempt): Error {
    if (context.power?.operation.action === 'power_off') return new TvServiceError('POWER_OFF_UNCONFIRMED', 500, context.lastFailure === undefined ? undefined : { cause: context.lastFailure });
    return context.operation.action === 'reconnect'
      ? new TvServiceError('RECOVERY_TIMEOUT', 500, context.lastFailure === undefined ? undefined : { cause: context.lastFailure })
      : new WebOsError('PAIRING_TIMEOUT', 'TV operation budget expired');
  }

  async function connect(context: Attempt, input: StartTvOperation, previous: StoredTv | null, signal: AbortSignal, budget: number): Promise<void> {
    const expiresAt = Math.min(context.expiresAt, scheduler.now() + budget);
    const checkConnection = () => {
      check(context);
      if (!signal.aborted && scheduler.now() >= expiresAt) throw new WebOsError('PAIRING_TIMEOUT', 'TV connection attempt budget expired');
      if (signal.aborted) throw signal.reason;
    };
    checkConnection();
    const host = 'host' in input ? input.host : previous!.host;
    const allowPrompt = input.action === 'pair' || input.action === 'repair';
    const initialKey = allowPrompt ? undefined : cipher.decrypt(previous!.encryptedCredential);
    const staging = createStagingKeyStore(initialKey);
    const adapter = dependencies.createAdapter(host, staging, budget, allowPrompt, platform);
    activeAdapter = adapter;
    if (platform === 'tizen' && context.power?.operation.action === 'recover') {
      if (!adapter.readPowerState) throw new WebOsError('UNSUPPORTED_CAPABILITY', 'Power observation unavailable');
      const version = generation;
      const reading = adapter.readPowerState(signal);
      let state: TvObservedPower;
      try { state = await abortable(reading, signal); }
      catch (cause) {
        if (!closed && generation === version && attempt === context) observedPower = 'unknown';
        checkConnection(); throw cause;
      }
      finally { await reading.catch(() => undefined); }
      checkConnection();
      observedPower = state;
      if (state !== 'on') throw context.lastFailure ?? unknownPowerObservation();
    }
    const result = await abortable(adapter.pair({ host, signal, ...(initialKey === undefined ? {} : { credential: initialKey }) }), signal);
    checkConnection();
    if (!result.credential) throw new WebOsError('INVALID_TV_RESPONSE', 'Registered response lacks a credential');
    const identity = tvIdentitySchema.strict().safeParse(result.identity);
    if (!identity.success) throw new WebOsError('INVALID_TV_RESPONSE', 'Registration identity is invalid');
    // Optional metadata absence is not an identity change on a verified ordinary reconnect.
    if (platform !== 'tizen' && input.action === 'reconnect' && previous?.host === host
      && previous.identity.model === identity.data.model
      && previous.identity.firmwareVersion === identity.data.firmwareVersion
      && identity.data.platformVersion === undefined && previous.identity.platformVersion !== undefined) {
      identity.data.platformVersion = previous.identity.platformVersion;
    }
    const snapshot = await abortable(adapter.readSnapshot(signal), signal);
    checkConnection();
    if (!tvSnapshotSchema.safeParse(snapshot).success || snapshot.connection !== 'available') throw new WebOsError('INVALID_TV_RESPONSE', 'Snapshot did not confirm availability');
    const identityChanged = previous?.identity.model !== identity.data.model
      || (platform !== 'tizen' && previous.identity.platformVersion !== identity.data.platformVersion)
      || previous.identity.firmwareVersion !== identity.data.firmwareVersion;
    // Network discovery may return another interface's MAC. Only the user
    // chooses the wake address; reconnect and identity/IP changes preserve it.
    const macAddress = previous ? previous.macAddress : input.action === 'pair' ? input.mac ?? null : null;
    if (input.action !== 'reconnect' || initialKey !== result.credential || identityChanged
      || previous?.identity.platformVersion !== identity.data.platformVersion) {
      let encryptedCredential: EncryptedEnvelopeV1;
      try { encryptedCredential = await abortable(Promise.resolve(cipher.encrypt(result.credential)), signal); }
      catch (cause) { if (signal.aborted) throw signal.reason; if (cause instanceof WebOsError) throw cause; throw new WebOsError('KEY_STORE_WRITE_FAILED', 'Unable to encrypt the registered key', { cause }); }
      const replacement: StoredTv = { platform, host, identity: identity.data, encryptedCredential, macAddress };
      checkConnection();
      try { repository.replace(replacement); }
      catch (cause) { throw new TvServiceError('STORAGE_FAILED', 500, { cause }); }
      saved = replacement;
    }
    connection = 'available'; error = undefined;
    if (platform === 'tizen' && adapter.readPowerState) {
      const state = await abortable(adapter.readPowerState(signal), signal);
      checkConnection();
      observedPower = state;
      if (state === 'unknown') error = projectTvError(unknownPowerObservation());
    }
    remoteCapability = { generation, buttons: supportsTvButtons(snapshot.capabilities), apps: snapshot.capabilities.apps === true, powerOff: snapshot.capabilities.powerOff === true };
    startVersionRead(adapter);
  }

  function reportVersionDiagnostic(code: TvVersionDiagnostic['code']): void {
    const operation = platform === 'tizen' ? 'sdb_capability' : 'hello';
    const diagnostic: TvVersionDiagnostic = { operation, code };
    try {
      if (dependencies.onVersionDiagnostic) dependencies.onVersionDiagnostic(diagnostic);
      else console.warn(diagnostic, 'Optional TV metadata unavailable');
    } catch {
      // A failing diagnostic consumer must remain visible without leaking its error data.
      console.error({ operation, code: 'diagnostic_failed' }, 'Optional TV metadata diagnostic failed');
    }
  }

  function startVersionRead(adapter: TvAdapter): void {
    if (!saved || (platform !== 'tizen' && saved.identity.platformVersion !== undefined) || !adapter.readPlatformVersion) return;
    const controller = new AbortController();
    const version = generation;
    const host = saved.host;
    const timer = scheduler.setTimeout(() => {
      reportVersionDiagnostic('timeout');
      controller.abort(new TvServiceError('CANCELLED'));
    }, statusBudgetMs);
    const live = () => !closed && !controller.signal.aborted && generation === version
      && activeAdapter === adapter && connection === 'available' && saved?.host === host;
    const pending = Promise.resolve().then(async () => {
      if (!live()) return;
      let result;
      try { result = await abortable(adapter.readPlatformVersion!(controller.signal), controller.signal); }
      catch {
        if (live()) reportVersionDiagnostic('read_failed');
        return;
      }
      if (!live()) return;
      if (!result || typeof result !== 'object') { reportVersionDiagnostic('invalid_response'); return; }
      if (result.diagnostic !== undefined) {
        const diagnostic = result.diagnostic;
        const valid = result.version === undefined && diagnostic?.operation === (platform === 'tizen' ? 'sdb_capability' : 'hello')
          && ['timeout', 'invalid_response', 'version_unavailable', 'request_rejected', 'send_failed'].includes(diagnostic.code);
        reportVersionDiagnostic(valid ? diagnostic.code : 'invalid_response'); return;
      }
      if (typeof result.version !== 'string') { reportVersionDiagnostic('invalid_response'); return; }
      const identity = tvIdentitySchema.strict().safeParse({ ...saved!.identity, platformVersion: result.version });
      if (!identity.success) { reportVersionDiagnostic('invalid_response'); return; }
      const replacement: StoredTv = { ...saved!, identity: identity.data };
      try { repository.replace(replacement); }
      catch { reportVersionDiagnostic('storage_failed'); return; }
      saved = replacement;
      if (platform === 'tizen') currentTizenVersion = true;
    });
    const current: Metadata = { adapter, controller, promise: pending.finally(() => {
      scheduler.clearTimeout(timer);
      if (metadata === current) metadata = undefined;
    }) };
    metadata = current;
  }

  function finish(context: Attempt, status: TvOperation['status'], cause?: unknown): void {
    if (attempt !== context) return;
    const projected = cause === undefined ? undefined : projectTvError(cause);
    context.operation = { ...context.operation, status, ...(projected ? { error: projected } : {}) };
    if (context.power) context.power.operation = { ...context.power.operation, status, phase: 'finished', ...(projected ? { error: projected } : {}) };
    if (status !== 'running') scheduler.clearTimeout(context.timer);
    if (context.power && status !== 'running') {
      const { operation, owner } = context.power;
      for (const listener of powerFinishedListeners) listener({ ...operation, ...(operation.error ? { error: { ...operation.error } } : {}) }, owner);
    }
    if (!context.power && status !== 'running') dependencies.onOperationFinished?.(copyOperation(context.operation));
  }

  async function run(context: Attempt, input: StartTvOperation, previous: StoredTv | null): Promise<void> {
    // Own the old connection before any abortable await: an early abort while
    // waiting for its probe must still disconnect it before releasing the gate.
    const previousAdapter = activeAdapter;
    let adapter: TvAdapter | undefined;
    let previousCleanup: Promise<void> | undefined;
    const signal = context.controller.signal;
    try {
      if (probe) { probe.controller.abort(new TvServiceError('CANCELLED')); await abortable(probe.promise, signal); }
      if (cleanup) { previousCleanup = cleanup.promise; await abortable(previousCleanup, signal); }
      if (activeAdapter) { previousCleanup = disconnect(activeAdapter); await abortable(previousCleanup, signal); }
      check(context);
      let failedAttempts = 0;
      while (true) {
        check(context);
        const remaining = context.expiresAt - scheduler.now();
        const budget = input.action === 'reconnect' ? recoveryAttemptBudget(remaining) : remaining;
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        const timer = scheduler.setTimeout(() => controller.abort(new WebOsError('PAIRING_TIMEOUT', 'TV connection attempt budget expired')), budget);
        try {
          await connect(context, input, previous, controller.signal, budget);
          finish(context, 'succeeded');
          // Successful manual connection supersedes connection-only failures.
          // Terminal delivery receipts were already retained by onPowerFinished;
          // send failures and uncertain delivery remain actionable diagnostics.
          if (!context.power && power && (power.operation.action === 'recover' && power.operation.status !== 'running'
            || power.operation.action === 'wake' && power.operation.status === 'failed' && power.operation.delivery === 'sent' && power.operation.error?.code === 'RECOVERY_TIMEOUT')) power = undefined;
          break;
        } catch (cause) {
          adapter = activeAdapter;
          latchCleanupFailure(cause);
          if (input.action !== 'reconnect' || signal.aborted || !isTransientTvFailure(cause)) throw cause;
          context.lastFailure = cause;
          const pendingCleanup = adapter ? disconnect(adapter) : undefined;
          if (pendingCleanup) {
            previousCleanup = pendingCleanup;
            try { await abortable(pendingCleanup, signal); }
            catch (cleanupCause) { if (signal.aborted) throw signal.reason; throw cleanupFailure(cause, cleanupCause); }
          }
          check(context);
          // Wake recovery owns one overall deadline. An individual retry is
          // diagnostic context, not a terminal failure of that operation.
          if (context.power?.operation.action !== 'wake') error = projectTvError(cause);
          await waitForTv(scheduler, Math.min(recoveryCooldown(++failedAttempts), context.expiresAt - scheduler.now()), signal);
        } finally {
          scheduler.clearTimeout(timer); signal.removeEventListener('abort', abort);
        }
      }
    } catch (cause) {
      const failure = signal.aborted ? signal.reason : cause;
      latchCleanupFailure(cause);
      if (signal.aborted && hasCleanupFailure(cause) && failure instanceof Error && failure !== cause) failure.cause = cause;
      const failureVersion = generation;
      const publishFailure = (reason: unknown) => {
        if (attempt !== context || generation !== failureVersion) return;
        const cancelled = context.operation.status === 'cancelled' || (reason instanceof TvServiceError && reason.code === 'CANCELLED');
        error = projectTvError(reason);
        finish(context, cancelled ? 'cancelled' : 'failed', reason);
        connection = cancelled ? (saved ? 'unavailable' : 'unconfigured') : failedConnection(reason);
      };
      // Terminal publication has the operation budget; cleanup remains owned and
      // blocks reuse independently, even when disconnect ignores cancellation.
      publishFailure(failure);
      adapter ??= activeAdapter;
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

  function start(input: StartTvOperation, owner?: string): TvOperation {
    input = assertCanStart(input);
    const startedAt = dependencies.now();
    const controller = new AbortController();
    const budget = input.action === 'reconnect' ? recoveryTimeoutMs : operationBudgetMs;
    const operation: TvOperation = { id: dependencies.newId(), action: input.action, status: 'running', startedAt, deadlineAt: startedAt + budget };
    const timer = scheduler.setTimeout(() => controller.abort(budgetFailure(context)), budget);
    const context: Attempt = { operation, controller, timer, expiresAt: scheduler.now() + budget, ...(owner === undefined ? {} : { owner }) };
    intentionalOff = false; recoverAfterProbe = false;
    attempt = context; generation++;
    observedPower = 'unknown';
    currentTizenVersion = false;
    metadata?.controller.abort(new TvServiceError('CANCELLED'));
    remoteCapability = undefined;
    connection = input.action === 'pair' || input.action === 'repair' ? 'pairing' : 'connecting';
    error = undefined;
    probe?.controller.abort(new TvServiceError('CANCELLED'));
    // Defer the worker so the synchronous start always publishes the accepted operation first.
    const pending = Promise.resolve().then(() => run(context, input, saved)).finally(() => { if (work === pending) work = undefined; });
    work = pending;
    return copyOperation(operation);
  }

  function cancel(id: string): TvOperation {
    if (!attempt || attempt.power || attempt.operation.id !== id) throw new TvServiceError('OPERATION_NOT_FOUND', 404);
    return cancelAttempt(attempt);
  }

  function cancelAttempt(context: Attempt): TvOperation {
    if (context.operation.status === 'running') {
      const cancelled = new TvServiceError('CANCELLED');
      finish(context, 'cancelled', cancelled);
      context.controller.abort(cancelled);
      // Before the deferred off worker starts there is no transport work to
      // invalidate; retain the capability tied to the existing live connection.
      if (context.power?.operation.action !== 'power_off' || context.power.operation.delivery !== 'not_sent') generation++;
      metadata?.controller.abort(cancelled);
    }
    return copyOperation(context.operation);
  }

  async function readStatus(adapter: TvAdapter, controller: AbortController, version: number): Promise<void> {
    const expiresAt = scheduler.now() + statusBudgetMs;
    const timer = scheduler.setTimeout(() => controller.abort(new WebOsError('CONNECTION_LOST', 'TV status read budget expired')), statusBudgetMs);
    try {
      const snapshot = await abortable(adapter.readSnapshot(controller.signal), controller.signal);
      if (scheduler.now() >= expiresAt) controller.abort(new WebOsError('CONNECTION_LOST', 'TV status read budget expired'));
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!tvSnapshotSchema.safeParse(snapshot).success || snapshot.connection !== 'available') throw new WebOsError('INVALID_TV_RESPONSE', 'Snapshot did not confirm availability');
      if (!closed && generation === version) { connection = 'available'; error = undefined; remoteCapability = { generation: version, buttons: supportsTvButtons(snapshot.capabilities), apps: snapshot.capabilities.apps === true, powerOff: snapshot.capabilities.powerOff === true }; }
    } catch (cause) {
      // A new operation/close owns cleanup after its cancellation; the old probe cannot publish.
      if (!closed && generation === version) {
        const failure = controller.signal.aborted ? controller.signal.reason : cause;
        latchCleanupFailure(failure);
        connection = failedConnection(failure); error = projectTvError(failure);
        recoverAfterProbe = !intentionalOff && isTransientTvFailure(failure);
        if (recoverAfterProbe) recoveryFailure = failure;
        // GET resolves on its own budget. The service still owns and awaits this
        // tracked cleanup on shutdown, and start rejects while it is pending.
        void disconnect(adapter).catch((cleanupCause: unknown) => {
          if (!closed && generation === version) error = projectTvError(cleanupFailure(failure, cleanupCause));
        });
      }
    } finally { scheduler.clearTimeout(timer); }
  }

  async function status(): Promise<TvStatusResponse> {
    if (!closed && !work && !command && !cleanup && (activeAdapter || platform === 'tizen' && saved)) {
      if (!probe) {
        const controller = new AbortController();
        const pending = platform === 'tizen' ? readSamsungStatus(controller, generation) : readStatus(activeAdapter!, controller, generation);
        const current: Probe = { controller, promise: pending.finally(() => { if (probe === current) probe = undefined; }) };
        probe = current;
      }
      await probe.promise;
    }
    const result = view();
    if (recoverAfterProbe && (platform !== 'tizen' || observedPower === 'on') && !closed && !work && !command && !probe && !unsafeCleanup && saved) {
      beginPower({ id: dependencies.newId(), action: 'recover' }, serverOwner);
    }
    return result;
  }

  async function readSamsungStatus(controller: AbortController, version: number): Promise<void> {
    const adapter = activeAdapter ?? dependencies.createAdapter(saved!.host, createStagingKeyStore(), statusBudgetMs, false, platform);
    const temporary = adapter !== activeAdapter;
    let reading: Promise<TvObservedPower> | undefined;
    const timer = scheduler.setTimeout(() => controller.abort(new WebOsError('INVALID_TV_RESPONSE', 'Power observation budget expired')), statusBudgetMs);
    try {
      if (!adapter.readPowerState) throw new WebOsError('UNSUPPORTED_CAPABILITY', 'Power observation unavailable');
      reading = adapter.readPowerState(controller.signal);
      const state = await abortable(reading, controller.signal);
      if (state === 'unknown') throw unknownPowerObservation();
      const physicallyWoke = observedPower === 'standby' && state === 'on';
      if (!closed && generation === version && !controller.signal.aborted) { observedPower = state; if (!recoverAfterProbe) error = undefined; }
      if (!temporary && !controller.signal.aborted) await readStatus(adapter, controller, version);
      if (physicallyWoke && !closed && generation === version && !controller.signal.aborted) {
        intentionalOff = false;
        if (connection === 'unavailable') recoverAfterProbe = true;
      }
    } catch (cause) {
      if (!closed && generation === version) { observedPower = 'unknown'; if (!recoverAfterProbe) error = projectTvError(controller.signal.aborted ? controller.signal.reason : cause); }
    } finally {
      scheduler.clearTimeout(timer);
      if (reading) await reading.catch(() => undefined);
      if (temporary) await disconnect(adapter);
    }
  }

  function unknownPowerObservation(): WebOsError {
    return new WebOsError('INVALID_TV_RESPONSE', 'Samsung power observation is unknown');
  }

  function assertIdle(): void {
    if (closed) throw new TvServiceError('SERVICE_CLOSED', 409);
    if (unsafeCleanup) throw new TvServiceError('CLEANUP_FAILED', 409, { cause: unsafeCleanup });
    if (work || cleanup || command || probe) throw new TvServiceError('OPERATION_CONFLICT', 409);
  }

  function canReplaceReconnect(): boolean {
    return !closed && !unsafeCleanup && !command && !probe && !!work && attempt?.operation.status === 'running'
      && (connection === 'connecting' || connection === 'unavailable')
      && attempt.operation.action === 'reconnect' && (!attempt.power || attempt.power.operation.action === 'recover');
  }

  function powerState(): TvPowerState {
    const idle = !closed && !unsafeCleanup && !work && !cleanup && !command && !probe;
    return {
      busy: !!(work || cleanup || command || probe),
      mac: saved?.macAddress ?? null,
      wakeSupported: supportsWake(),
      ...(platform === 'tizen' ? { observedPower } : {}),
      canPowerOff: platform === 'tizen' ? idle && !!saved && observedPower === 'on' : idle && connection === 'available' && !!activeAdapter?.powerOff && remoteCapability?.generation === generation && remoteCapability.powerOff === true,
      canWake: platform === 'tizen' ? idle && !!saved && observedPower === 'standby' : supportsWake() && !!saved?.macAddress && (idle && connection === 'unavailable' || canReplaceReconnect()),
      operation: power ? { ...power.operation, ...(power.operation.error ? { error: { ...power.operation.error } } : {}) } : null,
    };
  }

  function supportsWake(): boolean { return platform === 'webos' || platform === 'tizen'; }

  function setMac(mac: string | null): TvPowerState {
    assertIdle();
    if (!saved) throw new TvServiceError('INVALID_ACTION', 409);
    const parsed = tvMacAddressSchema.nullable().safeParse(mac);
    if (!parsed.success) throw new TvServiceError('INVALID_REQUEST', 400);
    const replacement = { ...saved, macAddress: parsed.data };
    try { repository.replace(replacement); }
    catch (cause) { throw new TvServiceError('STORAGE_FAILED', 500, { cause }); }
    saved = replacement;
    return powerState();
  }

  function assertCanStartPower(input: TvPowerRequest): TvPowerRequest {
    const parsed = tvPowerRequestSchema.safeParse(input);
    if (!parsed.success) throw new TvServiceError('INVALID_REQUEST', 400);
    if (!(parsed.data.action === 'wake' && canReplaceReconnect())) assertIdle();
    if (platform === 'tizen') {
      if (!saved) throw new TvServiceError('INVALID_ACTION', 409);
      if (observedPower === 'unknown') throw unknownPowerObservation();
      return parsed.data;
    }
    if (parsed.data.action === 'wake') {
      if (!supportsWake()) throw new TvServiceError('UNSUPPORTED_CAPABILITY', 409);
      if (!saved?.macAddress) throw new TvServiceError('WOL_NOT_CONFIGURED', 409);
      if (connection !== 'unavailable' && !canReplaceReconnect()) throw new TvServiceError('INVALID_ACTION', 409);
    } else {
      if (connection !== 'available' || !activeAdapter || remoteCapability?.generation !== generation) throw new TvServiceError('TV_UNAVAILABLE', 409);
      if (!remoteCapability.powerOff) throw new TvServiceError('UNSUPPORTED_CAPABILITY', 409);
    }
    return parsed.data;
  }

  function beginPower(input: { readonly id: string; readonly action: TvPowerOperation['action'] }, owner: string | symbol, previousWork?: Promise<void>): TvPowerOperation {
    const startedAt = dependencies.now();
    const budget = input.action === 'power_off' ? 5_000 : input.action === 'wake' ? Math.min(20_000, recoveryTimeoutMs) : recoveryTimeoutMs;
    const controller = new AbortController();
    const operation: TvPowerOperation = { id: input.id, action: input.action, startedAt, deadlineAt: startedAt + budget, status: 'running', phase: input.action === 'recover' ? 'connecting' : 'sending', delivery: 'not_sent' };
    const current: Power = { operation, owner };
    const timer = scheduler.setTimeout(() => controller.abort(budgetFailure(context)), budget);
    const context: Attempt = { operation: { id: input.id, action: 'reconnect', status: 'running', startedAt, deadlineAt: startedAt + budget }, power: current, owner, controller, timer, expiresAt: scheduler.now() + budget };
    if (platform === 'tizen' && input.action === 'recover') context.lastFailure = recoveryFailure;
    attempt = context; power = current; generation++;
    metadata?.controller.abort(new TvServiceError('CANCELLED'));
    // Power-off retains the verified capability for its own observation.
    if (remoteCapability) remoteCapability = { ...remoteCapability, generation };
    recoverAfterProbe = false;
    if (input.action !== 'power_off') { intentionalOff = false; if (platform !== 'tizen') connection = 'connecting'; remoteCapability = undefined; }
    error = undefined;
    const previous = saved!;
    const pending = Promise.resolve().then(() => runPower(context, previous, previousWork)).finally(() => { if (work === pending) work = undefined; });
    work = pending;
    return { ...operation };
  }

  function startPower(input: TvPowerRequest, owner: string): TvPowerOperation {
    const accepted = assertCanStartPower(input);
    const previousWork = accepted.action === 'wake' && canReplaceReconnect() ? work : undefined;
    if (previousWork) cancelAttempt(attempt!);
    return beginPower(accepted, owner, previousWork);
  }

  function cancelPower(id: string, owner: string): TvPowerOperation {
    if (!power || power.owner !== owner || power.operation.id !== id) throw new TvServiceError('OPERATION_NOT_FOUND', 404);
    if (attempt?.power === power && power.operation.status === 'running') cancelAttempt(attempt);
    return { ...power.operation, ...(power.operation.error ? { error: { ...power.operation.error } } : {}) };
  }

  async function cancelOwnedPower(owner: string): Promise<void> {
    if (attempt?.owner !== owner) return;
    cancelAttempt(attempt);
    await work;
    if (unsafeCleanup) throw unsafeCleanup;
  }

  async function observePowerOff(context: Attempt, adapter: TvAdapter): Promise<void> {
    const signal = context.controller.signal;
    while (true) {
      check(context);
      try {
        const snapshot = await abortable(adapter.readSnapshot(signal), signal);
        check(context);
        if (!tvSnapshotSchema.safeParse(snapshot).success) throw new WebOsError('INVALID_TV_RESPONSE', 'Power observation returned an invalid snapshot');
        if (snapshot.connection !== 'available') { connection = snapshot.connection === 'authorization_error' || snapshot.connection === 'compatibility_error' ? snapshot.connection : 'unavailable';
          if (connection !== 'unavailable') throw new WebOsError(connection === 'authorization_error' ? 'AUTHORIZATION_FAILED' : 'INVALID_TV_RESPONSE', 'Power observation did not confirm a usable connection');
          finish(context, 'succeeded'); return;
        }
        connection = 'available';
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        if (!isTransientTvFailure(cause)) throw cause;
        connection = 'unavailable'; error = projectTvError(cause);
        finish(context, 'succeeded'); return;
      }
      await waitForTv(scheduler, Math.min(1_000, context.expiresAt - scheduler.now()), signal);
    }
  }

  async function persistPowerPairing(context: Attempt, previous: StoredTv, pairing: PairingResult): Promise<void> {
    check(context);
    const identity = tvIdentitySchema.strict().safeParse(pairing.identity);
    if (!identity.success || !pairing.credential) throw new WebOsError('INVALID_TV_RESPONSE', 'Power registration metadata is invalid');
    let encryptedCredential: EncryptedEnvelopeV1;
    try { encryptedCredential = await abortable(Promise.resolve(cipher.encrypt(pairing.credential)), context.controller.signal); }
    catch (cause) { if (context.controller.signal.aborted) throw context.controller.signal.reason; throw new WebOsError('KEY_STORE_WRITE_FAILED', 'Unable to encrypt the registered key', { cause }); }
    check(context);
    const replacement = { ...previous, identity: identity.data, encryptedCredential };
    try { repository.replace(replacement); }
    catch (cause) { throw new TvServiceError('STORAGE_FAILED', 500, { cause }); }
    saved = replacement;
  }

  async function runSamsungPower(context: Attempt, previous: StoredTv, previousWork?: Promise<void>): Promise<void> {
    const current = context.power!;
    const signal = context.controller.signal;
    let adapter: TvAdapter | undefined;
    let pending: Promise<unknown> | undefined;
    let sendFailure: unknown;
    let persisted = false;
    try {
      if (previousWork) await abortable(previousWork, signal);
      check(context);
      const credential = cipher.decrypt(previous.encryptedCredential);
      adapter = activeAdapter ?? dependencies.createAdapter(previous.host, createStagingKeyStore(credential), Math.min(5_000, context.expiresAt - scheduler.now()), false, platform);
      if (!adapter.setPowerState || !adapter.readPowerState) throw new WebOsError('UNSUPPORTED_CAPABILITY', 'Samsung power operation unavailable');
      const desired = current.operation.action === 'power_off' ? 'standby' : 'on';
      current.operation = { ...current.operation, delivery: 'unknown' };
      pending = adapter.setPowerState(desired, { host: previous.host, credential, signal, async onPaired(pairing) {
        await persistPowerPairing(context, previous, pairing); persisted = true;
      } });
      try {
        const result = await abortable(pending as ReturnType<NonNullable<TvAdapter['setPowerState']>>, signal);
        check(context);
        current.operation = { ...current.operation, delivery: result.delivery, phase: 'connecting' };
        if (result.pairing && !persisted) await persistPowerPairing(context, previous, result.pairing);
      } catch (cause) {
        check(context);
        if (!(cause instanceof TvPowerSendError)) throw cause;
        current.operation = { ...current.operation, delivery: cause.delivery, phase: 'connecting' };
        if (cause.cause instanceof TvServiceError) throw cause.cause;
        if (cause.delivery !== 'unknown') throw cause;
        sendFailure = cause; context.lastFailure = cause;
      }
      while (true) {
        check(context);
        try {
          pending = adapter.readPowerState(signal);
          const state = await abortable(pending as Promise<TvObservedPower>, signal);
          check(context); observedPower = state;
          if (state === desired) break;
          if (state === 'unknown') throw unknownPowerObservation();
        } catch (cause) {
          check(context); observedPower = 'unknown'; context.lastFailure = cause;
          if (!isTransientTvFailure(cause)) throw cause;
        }
        await waitForTv(scheduler, Math.min(1_000, context.expiresAt - scheduler.now()), signal);
      }
      check(context);
      if (desired === 'standby') {
        intentionalOff = true;
        // HTTP standby says nothing about whether the owned WSS is usable.
        if (adapter !== activeAdapter) await abortable(disconnect(adapter), signal);
        check(context); error = undefined; finish(context, 'succeeded');
      } else {
        if (adapter !== activeAdapter) await abortable(disconnect(adapter), signal);
        check(context);
        await run(context, { action: 'reconnect' }, saved ?? previous);
      }
    } catch (cause) {
      const failure = signal.aborted ? signal.reason : cause;
      if (failure instanceof Error && sendFailure && failure !== sendFailure) failure.cause = sendFailure;
      latchCleanupFailure(cause);
      if (attempt === context && context.operation.status === 'running') {
        error = projectTvError(failure); finish(context, 'failed', failure);
      }
      if (pending) await pending.catch((lateCause: unknown) => { latchCleanupFailure(lateCause); });
      if (adapter) {
        try { await disconnect(adapter); }
        catch (cleanupCause) {
          if (attempt === context) { error = projectTvError(cleanupFailure(failure, cleanupCause)); if (context.operation.status !== 'cancelled') finish(context, 'failed', cleanupFailure(failure, cleanupCause)); }
        }
      }
    } finally { scheduler.clearTimeout(context.timer); }
  }

  async function runPower(context: Attempt, previous: StoredTv, previousWork?: Promise<void>): Promise<void> {
    const current = context.power!;
    if (current.operation.action === 'recover') { await run(context, { action: 'reconnect' }, previous); return; }
    if (platform === 'tizen') { await runSamsungPower(context, previous, previousWork); return; }
    const signal = context.controller.signal;
    let adapter: TvAdapter | undefined;
    let pending: Promise<void> | undefined;
    let ownedCleanup: Promise<void> | undefined;
    let observedSend = false;
    try {
      // Keep ownership until the superseded connection has disposed its transport.
      // A timeout or cancellation must not release this cleanup gate early.
      if (previousWork) await abortable(previousWork, signal);
      check(context);
      adapter = current.operation.action === 'power_off' ? activeAdapter! : dependencies.createAdapter(previous.host, createStagingKeyStore(), Math.min(5_000, context.expiresAt - scheduler.now()), false, platform);
      if (current.operation.action === 'wake') activeAdapter = adapter;
      if (current.operation.action === 'power_off' ? !adapter.powerOff : !adapter.wake) throw new WebOsError('UNSUPPORTED_CAPABILITY', 'Adapter does not support the requested power operation');
      current.operation = { ...current.operation, delivery: 'unknown' };
      observedSend = true;
      pending = current.operation.action === 'power_off' ? adapter.powerOff!(signal) : adapter.wake!([previous.macAddress!], signal);
      await abortable(pending, signal);
      check(context);
      current.operation = { ...current.operation, delivery: 'sent', phase: 'connecting' };
      if (current.operation.action === 'power_off') {
        intentionalOff = true;
        await observePowerOff(context, adapter);
        ownedCleanup = disconnect(adapter);
        await ownedCleanup;
      } else {
        ownedCleanup = disconnect(adapter);
        await abortable(ownedCleanup, signal);
        await run(context, { action: 'reconnect' }, previous);
      }
    } catch (cause) {
      const failure = signal.aborted ? signal.reason : cause;
      latchCleanupFailure(cause);
      if (signal.aborted && hasCleanupFailure(cause) && failure instanceof Error && failure !== cause) failure.cause = cause;
      if (cause instanceof TvPowerSendError && current.operation.delivery !== 'sent') current.operation = { ...current.operation, delivery: cause.delivery };
      if (current.operation.action === 'power_off' && current.operation.delivery !== 'not_sent') intentionalOff = true;
      if (attempt === context) {
        error = projectTvError(failure);
        finish(context, context.operation.status === 'cancelled' ? 'cancelled' : 'failed', failure);
        if (!(failure instanceof TvServiceError && failure.code === 'POWER_OFF_UNCONFIRMED') && !(failure instanceof TvServiceError && failure.code === 'CANCELLED')) connection = failedConnection(failure);
        if (current.operation.action === 'wake' && failure instanceof TvServiceError && failure.code === 'CANCELLED') connection = 'unavailable';
        if (current.operation.delivery === 'not_sent' && failure instanceof WebOsError && failure.code === 'UNSUPPORTED_CAPABILITY' && remoteCapability) remoteCapability = { ...remoteCapability, powerOff: false };
      }
      // Publication is bounded; transport and cleanup ownership are not released
      // by racing an AbortSignal. Late completion cannot rewrite the terminal result.
      if (previousWork) await previousWork;
      if (pending) await pending.then(() => undefined, (lateCause: unknown) => {
        latchCleanupFailure(lateCause);
        if (signal.aborted && failure instanceof Error && lateCause !== failure) failure.cause = lateCause;
      });
      if (attempt === context && hasCleanupFailure(failure)) {
        error = projectTvError(failure);
        finish(context, context.operation.status === 'cancelled' ? 'cancelled' : 'failed', failure);
      }
      if (adapter && (current.operation.action === 'wake' || observedSend && current.operation.delivery !== 'not_sent')) {
        try { await (ownedCleanup ?? disconnect(adapter)); }
        catch (cleanupCause) { if (attempt === context) { error = projectTvError(cleanupFailure(failure, cleanupCause)); finish(context, context.operation.status === 'cancelled' ? 'cancelled' : 'failed', cleanupFailure(failure, cleanupCause)); } }
      }
    } finally { scheduler.clearTimeout(context.timer); }
  }

  function remoteState(): TvRemoteState {
    // Background reads do not disable the remote. An admitted command retains
    // ownership while awaiting their result before touching the transport.
    if (work || cleanup || command) return { enabled: false, reason: 'BUSY' };
    if (closed || unsafeCleanup || connection !== 'available' || !activeAdapter || remoteCapability?.generation !== generation) return { enabled: false, reason: 'UNAVAILABLE' };
    if (remoteCapability.buttons !== true) return { enabled: false, reason: 'UNSUPPORTED' };
    return { enabled: true, reason: null, apps: remoteCapability.apps };
  }

  function assertCanSendCommand(input: TvCommandRequest): TvCommandRequest {
    const parsed = tvCommandRequestSchema.safeParse(input);
    if (!parsed.success) throw new TvServiceError('INVALID_REQUEST', 400);
    const state = remoteState();
    if (!state.enabled) throw new TvCommandAdmissionError(state.reason === 'BUSY' ? 'TV_BUSY' : state.reason === 'UNSUPPORTED' ? 'UNSUPPORTED_CAPABILITY' : 'TV_UNAVAILABLE');
    if ('app' in parsed.data && remoteCapability?.apps !== true) throw new TvCommandAdmissionError('UNSUPPORTED_CAPABILITY');
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
      if (probe) {
        try { await abortable(probe.promise, controller.signal); }
        catch (cause) {
          if (!controller.signal.aborted) throw cause;
          return rejectTvCommand(input.id, 'COMMAND_NOT_SENT');
        }
      }
      if (closed || version !== generation || controller.signal.aborted) return rejectTvCommand(input.id, 'COMMAND_NOT_SENT');
      if (scheduler.now() >= expiresAt) { expire(); return rejectTvCommand(input.id, 'COMMAND_NOT_SENT'); }
      if (unsafeCleanup || cleanup || connection !== 'available' || activeAdapter !== adapter || remoteCapability?.generation !== version) return rejectTvCommand(input.id, 'TV_UNAVAILABLE');
      if (remoteCapability.buttons !== true || 'app' in input && remoteCapability.apps !== true) return rejectTvCommand(input.id, 'UNSUPPORTED_CAPABILITY');
      started = true;
      const result = await executeTvCommand(input, adapter, controller.signal);
      if (scheduler.now() >= expiresAt && !controller.signal.aborted) expire();
      if (controller.signal.aborted && result.outcome === 'sent') return unknownTvCommand(input.id);
      if (!('app' in input) && !closed && version === generation && result.outcome === 'rejected' && result.error.code === 'UNSUPPORTED_CAPABILITY') remoteCapability = { ...remoteCapability, buttons: false };
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
    if (platform === 'tizen' && saved) {
      await status();
      if (observedPower !== 'on') return;
    }
    if (saved && !work && !closed) start({ action: 'reconnect' });
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; generation++;
    metadata?.controller.abort(new TvServiceError('CANCELLED'));
    if (attempt?.operation.status === 'running') cancelAttempt(attempt);
    probe?.controller.abort(new TvServiceError('CANCELLED'));
    command?.controller.abort(new TvServiceError('CANCELLED'));
    closing = (async () => {
      await command?.promise;
      await metadata?.promise;
      await work; await probe?.promise;
      await cleanup?.promise;
      if (activeAdapter) await disconnect(activeAdapter);
      if (unsafeCleanup) throw unsafeCleanup;
    })().finally(() => { powerFinishedListeners.clear(); });
    return closing;
  }
  return {
    assertCanStart, start, status, cancel, initialize, close, remoteState, assertCanSendCommand, sendCommand, powerState, setMac, assertCanStartPower, startPower, cancelPower, cancelOwnedPower,
    onPowerFinished(listener) { powerFinishedListeners.add(listener); return () => { powerFinishedListeners.delete(listener); }; },
  };
}

function copyOperation(operation: TvOperation): TvOperation {
  return { ...operation, ...(operation.error ? { error: { ...operation.error } } : {}) };
}

function withoutPlatformVersion(identity: StoredTv['identity']): StoredTv['identity'] {
  const { platformVersion: _version, ...rest } = identity;
  return rest;
}
