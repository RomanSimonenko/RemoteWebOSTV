import type { TvSnapshot } from '@remote-webos-tv/contracts';
import { createClientKeyCipher, type ClientKeyStore, type PairingRequest, type PairingResult, type WebOsAdapter } from '@remote-webos-tv/webos';
import { createTvService, type TvServiceDependencies, type TvScheduler } from '../../src/tv/service.js';
import type { StoredTv, TvRepository } from '../../src/tv/repository.js';

export function barrier<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export const identity = { model: 'Synthetic Model' };
export const capabilities = { ssap: true, pointer: true, powerOff: true, wakeOnLan: false, apps: true, inputs: true, textInput: true, notifications: true };
export const pairing: PairingResult = { clientKey: 'synthetic-key', identity, capabilities, transport: 'ws:3000', macAddresses: [] };
export const snapshot: TvSnapshot = { connection: 'available', identity, capabilities, volume: 17, muted: false };

// Microtasks, not elapsed time: late-result doubles intentionally ignore AbortSignal.
export async function drain() { for (let index = 0; index < 40; index++) await Promise.resolve(); }

export class ControlledScheduler implements TvScheduler {
  time = 0;
  #next = 0;
  #timers = new Map<number, { at: number; run: () => void }>();
  now = () => this.time;
  setTimeout(run: () => void, delay: number): unknown {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.time + delay, run });
    return id;
  }
  clearTimeout(handle: unknown) { this.#timers.delete(handle as number); }
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at <= this.time) { this.#timers.delete(id); timer.run(); }
    }
  }
}

export class ControlledAdapter implements WebOsAdapter {
  readonly enteredPair = barrier<PairingRequest>();
  readonly enteredRead = barrier<AbortSignal>();
  readonly disconnected = barrier<void>();
  pairResult = barrier<PairingResult>();
  readResult = barrier<TvSnapshot>();
  disconnectResult: Promise<void> = Promise.resolve();
  reads = 0;
  pairs = 0;
  closed = false;
  constructor(readonly staging: ClientKeyStore) {}
  async pair(request: PairingRequest) {
    this.pairs++;
    this.enteredPair.resolve(request);
    return this.pairResult.promise;
  }
  async readSnapshot(signal: AbortSignal) { this.reads++; this.enteredRead.resolve(signal); return this.readResult.promise; }
  async disconnect() { this.closed = true; await this.disconnectResult; this.disconnected.resolve(); }
  async openPointerSocket() { throw new Error('outside test scope'); }
  async listApps() { return []; }
  async listInputs() { return []; }
  async sendButton() { throw new Error('outside test scope'); }
}

export function harness(saved = false, overrides: Partial<TvServiceDependencies> = {}) {
  const cipher = createClientKeyCipher(Buffer.alloc(32, 7));
  let stored: StoredTv | null = saved ? { host: '192.168.1.10', identity, encryptedClientKey: cipher.encrypt('synthetic-key') } : null;
  const writes: StoredTv[] = [];
  const repository: TvRepository = {
    load: () => stored,
    hasStoredKey: () => stored !== null,
    replace(value) { stored = value; writes.push(value); },
  };
  const scheduler = new ControlledScheduler();
  const adapters: ControlledAdapter[] = [];
  const policies: Array<{ host: string; timeout: number; prompt: boolean }> = [];
  let epoch = 1_000_000;
  let id = 0;
  const service = createTvService({ repository, cipher, scheduler, now: () => epoch, newId: () => `operation-${++id}`,
    createAdapter(host, staging, timeout, prompt) {
      policies.push({ host, timeout, prompt });
      const adapter = new ControlledAdapter(staging); adapters.push(adapter); return adapter;
    }, ...overrides });
  return { service, repository, cipher, scheduler, adapters, policies, writes, setEpoch: (value: number) => { epoch = value; } };
}

export async function succeed(adapter: ControlledAdapter) {
  await adapter.enteredPair.promise;
  await adapter.staging.save('synthetic-key');
  adapter.pairResult.resolve(pairing);
  await adapter.enteredRead.promise;
  adapter.readResult.resolve(snapshot);
  await drain();
}
