import { startTvOperationSchema, tvCommandRequestSchema, tvIdentitySchema, tvMacAddressSchema, tvPowerRequestSchema, tvSnapshotSchema, type StartTvOperation, type TvCommandRequest, type TvCommandResult, type TvConnectionState, type TvOperation, type TvPowerOperation, type TvPowerRequest, type TvPowerState, type TvRemoteState, type TvStatusResponse } from '@remote-webos-tv/contracts';
import { TvPowerSendError, WebOsError, type ClientKeyCipher, type ClientKeyStore, type EncryptedEnvelopeV1, type WebOsAdapter } from '@remote-webos-tv/webos';
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
  readonly repository: TvRepository;
  readonly cipher: {
    decrypt: ClientKeyCipher['decrypt'];
    encrypt(key: string): EncryptedEnvelopeV1 | Promise<EncryptedEnvelopeV1>;
  };
  readonly createAdapter: (host: string, staging: ClientKeyStore, requestTimeoutMs: number, allowPairingPrompt: boolean) => WebOsAdapter;
  readonly now: () => number;
  readonly newId: () => string;
  readonly scheduler: TvScheduler;
  readonly recoveryTimeoutMs?: number;
  readonly onVersionDiagnostic?: (diagnostic: TvVersionDiagnostic) => void;
}
export interface TvVersionDiagnostic {
  readonly operation: 'hello';
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
interface Cleanup { readonly adapter: WebOsAdapter; readonly promise: Promise<void> }
interface Command { readonly controller: AbortController; readonly promise: Promise<TvCommandResult> }
interface Metadata extends Probe { readonly adapter: WebOsAdapter }

export function createTvService(dependencies: TvServiceDependencies): TvService {
  const { repository, cipher, scheduler } = dependencies;
  const recoveryTimeoutMs = dependencies.recoveryTimeoutMs ?? 60_000;
  if (!Number.isInteger(recoveryTimeoutMs) || recoveryTimeoutMs < 1_000 || recoveryTimeoutMs > 300_000) throw new Error('Invalid TV recovery timeout');
  let saved = repository.load();
  let connection: TvConnectionState = saved ? 'unavailable' : 'unconfigured';
  let error: PublicTvError | undefined;
  let attempt: Attempt | undefined;
  let work: Promise<void> | undefined;
  let activeAdapter: WebOsAdapter | undefined;
  let probe: Probe | undefined;
  let cleanup: Cleanup | undefined;
  let command: Command | undefined;
  let metadata: Metadata | undefined;
  let remoteCapability: { readonly generation: number; readonly pointer: boolean; readonly powerOff: boolean } | undefined;
  let power: Power | undefined;
  let intentionalOff = false;
  let recoverAfterProbe = false;
  const serverOwner = Symbol('automatic TV recovery');
  let generation = 0;
  let initialized = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let unsafeCleanup: unknown;
  const powerFinishedListeners = new Set<(operation: TvPowerOperation, owner: string | symbol) => void>();

  const view = (): TvStatusResponse => ({
    tv: saved ? { host: saved.host, identity: { ...saved.identity } } : null,
    connection,
    operation: attempt && !attempt.power ? copyOperation(attempt.operation) : null,
    ...(error ? { error: { ...error } } : {}),
  });

  function latchCleanupFailure(cause: unknown): void {
    if (hasCleanupFailure(cause)) unsafeCleanup ??= new TvServiceError('CLEANUP_FAILED', 500, { cause });
  }

  function disconnect(adapter: WebOsAdapter): Promise<void> {
    if (metadata?.adapter === adapter) metadata.controller.abort(new TvServiceError('CANCELLED'));
    if (cleanup?.adapter === adapter) return cleanup.promise;
    if (activeAdapter === adapter) {
      activeAdapter = undefined; remoteCapability = undefined;
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
    if (context.power?.operation.action === 'power_off') return new TvServiceError('POWER_OFF_UNCONFIRMED');
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
    const initialKey = allowPrompt ? undefined : cipher.decrypt(previous!.encryptedClientKey);
    const staging = createStagingKeyStore(initialKey);
    const adapter = dependencies.createAdapter(host, staging, budget, allowPrompt);
    activeAdapter = adapter;
    const result = await abortable(adapter.pair({ host, signal, ...(initialKey === undefined ? {} : { clientKey: initialKey }) }), signal);
    checkConnection();
    if (!result.clientKey) throw new WebOsError('INVALID_TV_RESPONSE', 'Registered response lacks a client key');
    const identity = tvIdentitySchema.strict().safeParse(result.identity);
    if (!identity.success) throw new WebOsError('INVALID_TV_RESPONSE', 'Registration identity is invalid');
    // Optional metadata absence is not an identity change on a verified ordinary reconnect.
    if (input.action === 'reconnect' && previous?.host === host
      && previous.identity.model === identity.data.model
      && previous.identity.firmwareVersion === identity.data.firmwareVersion
      && identity.data.platformVersion === undefined && previous.identity.platformVersion !== undefined) {
      identity.data.platformVersion = previous.identity.platformVersion;
    }
    const snapshot = await abortable(adapter.readSnapshot(signal), signal);
    checkConnection();
    if (!tvSnapshotSchema.safeParse(snapshot).success || snapshot.connection !== 'available') throw new WebOsError('INVALID_TV_RESPONSE', 'Snapshot did not confirm availability');
    const identityChanged = previous?.identity.model !== identity.data.model
      || previous.identity.platformVersion !== identity.data.platformVersion
      || previous.identity.firmwareVersion !== identity.data.firmwareVersion;
    let discoveredMac: string | null = null;
    for (const candidate of result.macAddresses) {
      const parsed = tvMacAddressSchema.safeParse(candidate);
      if (parsed.success) { discoveredMac = parsed.data; break; }
    }
    const macAddress = input.action === 'change_address' || identityChanged
      ? discoveredMac
      : input.action === 'reconnect' ? previous!.macAddress : previous?.macAddress ?? discoveredMac;
    if (input.action !== 'reconnect' || initialKey !== result.clientKey || identityChanged) {
      let encryptedClientKey: EncryptedEnvelopeV1;
      try { encryptedClientKey = await abortable(Promise.resolve(cipher.encrypt(result.clientKey)), signal); }
      catch (cause) { if (signal.aborted) throw signal.reason; if (cause instanceof WebOsError) throw cause; throw new WebOsError('KEY_STORE_WRITE_FAILED', 'Unable to encrypt the registered key', { cause }); }
      const replacement: StoredTv = { host, identity: identity.data, encryptedClientKey, macAddress };
      checkConnection();
      try { repository.replace(replacement); }
      catch (cause) { throw new TvServiceError('STORAGE_FAILED', 500, { cause }); }
      saved = replacement;
    }
    connection = 'available'; error = undefined;
    remoteCapability = { generation, pointer: snapshot.capabilities.pointer === true, powerOff: snapshot.capabilities.powerOff === true };
    startVersionRead(adapter);
  }

  function reportVersionDiagnostic(code: TvVersionDiagnostic['code']): void {
    const diagnostic: TvVersionDiagnostic = { operation: 'hello', code };
    try {
      if (dependencies.onVersionDiagnostic) dependencies.onVersionDiagnostic(diagnostic);
      else console.warn(diagnostic, 'Optional TV metadata unavailable');
    } catch {
      // A failing diagnostic consumer must remain visible without leaking its error data.
      console.error({ operation: 'hello', code: 'diagnostic_failed' }, 'Optional TV metadata diagnostic failed');
    }
  }

  function startVersionRead(adapter: WebOsAdapter): void {
    if (!saved || saved.identity.platformVersion !== undefined || !adapter.readPlatformVersion) return;
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
        const valid = result.version === undefined && diagnostic?.operation === 'hello'
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
          error = projectTvError(cause);
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
    metadata?.controller.abort(new TvServiceError('CANCELLED'));
    remoteCapability = undefined;
    connection = input.action === 'pair' || input.action === 'repair' ? 'pairing' : 'connecting';
    error = undefined;
    probe?.controller.abort(new TvServiceError('CANCELLED'));
    // Defer the worker so the synchronous start always publishes the accepted operation first.
    work = Promise.resolve().then(() => run(context, input, saved)).finally(() => { work = undefined; });
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

  async function readStatus(adapter: WebOsAdapter, controller: AbortController, version: number): Promise<void> {
    const expiresAt = scheduler.now() + statusBudgetMs;
    const timer = scheduler.setTimeout(() => controller.abort(new WebOsError('CONNECTION_LOST', 'TV status read budget expired')), statusBudgetMs);
    try {
      const snapshot = await abortable(adapter.readSnapshot(controller.signal), controller.signal);
      if (scheduler.now() >= expiresAt) controller.abort(new WebOsError('CONNECTION_LOST', 'TV status read budget expired'));
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!tvSnapshotSchema.safeParse(snapshot).success || snapshot.connection !== 'available') throw new WebOsError('INVALID_TV_RESPONSE', 'Snapshot did not confirm availability');
      if (!closed && generation === version) { connection = 'available'; error = undefined; remoteCapability = { generation: version, pointer: snapshot.capabilities.pointer === true, powerOff: snapshot.capabilities.powerOff === true }; }
    } catch (cause) {
      // A new operation/close owns cleanup after its cancellation; the old probe cannot publish.
      if (!closed && generation === version) {
        const failure = controller.signal.aborted ? controller.signal.reason : cause;
        latchCleanupFailure(failure);
        connection = failedConnection(failure); error = projectTvError(failure);
        recoverAfterProbe = !intentionalOff && isTransientTvFailure(failure);
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
    const result = view();
    if (recoverAfterProbe && !closed && !work && !command && !probe && !unsafeCleanup && saved) {
      recoverAfterProbe = false;
      beginPower({ id: dependencies.newId(), action: 'recover' }, serverOwner);
    }
    return result;
  }

  function assertIdle(): void {
    if (closed) throw new TvServiceError('SERVICE_CLOSED', 409);
    if (unsafeCleanup) throw new TvServiceError('CLEANUP_FAILED', 409, { cause: unsafeCleanup });
    if (work || cleanup || command || probe) throw new TvServiceError('OPERATION_CONFLICT', 409);
  }

  function powerState(): TvPowerState {
    const idle = !closed && !unsafeCleanup && !work && !cleanup && !command && !probe;
    return {
      mac: saved?.macAddress ?? null,
      canPowerOff: idle && connection === 'available' && !!activeAdapter && remoteCapability?.generation === generation && remoteCapability.powerOff === true,
      canWake: idle && !!saved?.macAddress && connection === 'unavailable',
      operation: power ? { ...power.operation, ...(power.operation.error ? { error: { ...power.operation.error } } : {}) } : null,
    };
  }

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
    assertIdle();
    if (parsed.data.action === 'wake') {
      if (!saved?.macAddress) throw new TvServiceError('WOL_NOT_CONFIGURED', 409);
      if (connection !== 'unavailable') throw new TvServiceError('INVALID_ACTION', 409);
    } else {
      if (connection !== 'available' || !activeAdapter || remoteCapability?.generation !== generation) throw new TvServiceError('TV_UNAVAILABLE', 409);
      if (!remoteCapability.powerOff) throw new TvServiceError('UNSUPPORTED_CAPABILITY', 409);
    }
    return parsed.data;
  }

  function beginPower(input: { readonly id: string; readonly action: TvPowerOperation['action'] }, owner: string | symbol): TvPowerOperation {
    const startedAt = dependencies.now();
    const budget = input.action === 'power_off' ? 5_000 : recoveryTimeoutMs;
    const controller = new AbortController();
    const operation: TvPowerOperation = { id: input.id, action: input.action, startedAt, deadlineAt: startedAt + budget, status: 'running', phase: input.action === 'recover' ? 'connecting' : 'sending', delivery: 'not_sent' };
    const current: Power = { operation, owner };
    const timer = scheduler.setTimeout(() => controller.abort(budgetFailure(context)), budget);
    const context: Attempt = { operation: { id: input.id, action: 'reconnect', status: 'running', startedAt, deadlineAt: startedAt + budget }, power: current, owner, controller, timer, expiresAt: scheduler.now() + budget };
    attempt = context; power = current; generation++;
    metadata?.controller.abort(new TvServiceError('CANCELLED'));
    // Power-off retains the verified capability for its own observation.
    if (remoteCapability) remoteCapability = { ...remoteCapability, generation };
    recoverAfterProbe = false;
    if (input.action !== 'power_off') { intentionalOff = false; connection = 'connecting'; remoteCapability = undefined; }
    error = undefined;
    const previous = saved!;
    work = Promise.resolve().then(() => runPower(context, previous)).finally(() => { work = undefined; });
    return { ...operation };
  }

  function startPower(input: TvPowerRequest, owner: string): TvPowerOperation {
    return beginPower(assertCanStartPower(input), owner);
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

  async function observePowerOff(context: Attempt, adapter: WebOsAdapter): Promise<void> {
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

  async function runPower(context: Attempt, previous: StoredTv): Promise<void> {
    const current = context.power!;
    if (current.operation.action === 'recover') { await run(context, { action: 'reconnect' }, previous); return; }
    const signal = context.controller.signal;
    let adapter: WebOsAdapter | undefined;
    let pending: Promise<void> | undefined;
    let ownedCleanup: Promise<void> | undefined;
    let observedSend = false;
    try {
      check(context);
      adapter = current.operation.action === 'power_off' ? activeAdapter! : dependencies.createAdapter(previous.host, createStagingKeyStore(), Math.min(5_000, context.expiresAt - scheduler.now()), false);
      if (current.operation.action === 'wake') activeAdapter = adapter;
      current.operation = { ...current.operation, delivery: 'unknown' };
      observedSend = true;
      pending = current.operation.action === 'power_off' ? adapter.powerOff(signal) : adapter.wake([previous.macAddress!], signal);
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
      if (pending) await pending.then(() => undefined, (lateCause: unknown) => {
        latchCleanupFailure(lateCause);
        if (signal.aborted && failure instanceof Error && lateCause !== failure) failure.cause = lateCause;
      });
      if (attempt === context && hasCleanupFailure(failure)) {
        error = projectTvError(failure);
        finish(context, context.operation.status === 'cancelled' ? 'cancelled' : 'failed', failure);
      }
      if (adapter && observedSend && (current.operation.action === 'wake' || current.operation.delivery !== 'not_sent')) {
        try { await (ownedCleanup ?? disconnect(adapter)); }
        catch (cleanupCause) { if (attempt === context) { error = projectTvError(cleanupFailure(failure, cleanupCause)); finish(context, context.operation.status === 'cancelled' ? 'cancelled' : 'failed', cleanupFailure(failure, cleanupCause)); } }
      }
    } finally { scheduler.clearTimeout(context.timer); }
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
      if (!closed && version === generation && result.outcome === 'rejected' && result.error.code === 'UNSUPPORTED_CAPABILITY') remoteCapability = { generation: version, pointer: false, powerOff: remoteCapability?.powerOff === true };
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
