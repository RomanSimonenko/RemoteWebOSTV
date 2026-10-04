import { WebOsError } from '@remote-webos-tv/webos';
import type { TvScheduler } from './service.js';

/** Recovery policy only; the service owns every adapter, state and operation. */
export function recoveryAttemptBudget(remainingMs: number): number {
  return Math.min(5_000, remainingMs);
}

export function recoveryCooldown(failedAttempts: number): number {
  return [1_000, 2_000, 4_000][failedAttempts - 1] ?? 8_000;
}

export function isTransientTvFailure(cause: unknown): boolean {
  return cause instanceof WebOsError && ['NETWORK_UNREACHABLE', 'CONNECTION_LOST', 'PAIRING_TIMEOUT'].includes(cause.code);
}

export function waitForTv(scheduler: TvScheduler, delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: unknown;
    const abort = () => { scheduler.clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) { reject(signal.reason); return; }
    timer = scheduler.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}
