import type { SamsungScheduler, SamsungSocket } from '../../src/samsung-adapter.js';

// Complete required structure observed on the authorized fresh connect sample.
// All values are synthetic. No OS version was present in the HTTP sample.
export const identitySample = {
  device: {
    OS: 'Tizen', PowerState: 'on', TokenAuthSupport: 'true', firmwareVersion: 'synthetic-fw',
    id: 'synthetic-device', duid: 'synthetic-duid', model: 'synthetic-family',
    modelName: 'Synthetic Samsung', name: 'Synthetic TV', wifiMac: '02:00:00:00:00:01',
  },
  id: 'synthetic-root', isSupport: '{}', name: 'Synthetic TV', remote: '1.0',
  type: 'Samsung SmartTV', uri: 'synthetic-uri', version: '2.0.25',
};

export function connectSample(token: string | undefined = 'synthetic-token') {
  return {
    event: 'ms.channel.connect',
    data: {
      clients: [{ attributes: { name: 'UmVtb3RlV2ViT1NUVg==' }, connectTime: 100,
        deviceName: 'Synthetic client', id: 'synthetic-client', isHost: false }],
      id: 'synthetic-client', ...(token === undefined ? {} : { token }),
    },
  };
}

export class ManualScheduler implements SamsungScheduler {
  readonly timers = new Map<number, { callback: () => void; delay: number }>();
  #next = 0;
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.#next;
    this.timers.set(id, { callback, delay });
    return id;
  }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  fireAll() {
    for (const [id, timer] of [...this.timers]) {
      this.timers.delete(id);
      timer.callback();
    }
  }
}

export class ControlledSocket implements SamsungSocket {
  readyState = 0;
  readonly frames: string[] = [];
  readonly openListeners = new Set<() => void>();
  readonly closeListeners = new Set<() => void>();
  readonly errorListeners = new Set<(error: Error) => void>();
  readonly messageListeners = new Set<(text: string) => void>();
  sendCallback: ((error?: Error) => void) | undefined;
  deferSend = false;
  terminateCount = 0;
  onOpen(listener: () => void) { this.openListeners.add(listener); return () => this.openListeners.delete(listener); }
  onClose(listener: () => void) { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  onError(listener: (error: Error) => void) { this.errorListeners.add(listener); return () => this.errorListeners.delete(listener); }
  onMessage(listener: (text: string) => void) { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  open() { this.readyState = 1; for (const listener of this.openListeners) listener(); }
  message(payload: unknown) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const listener of this.messageListeners) listener(text);
  }
  close() { this.readyState = 3; for (const listener of [...this.closeListeners]) listener(); }
  error() { for (const listener of [...this.errorListeners]) listener(new Error('Synthetic transport failure')); }
  send(text: string, callback: (error?: Error) => void) {
    this.frames.push(text);
    if (this.deferSend) this.sendCallback = callback;
    else callback();
  }
  terminate() { this.terminateCount++; this.close(); }
  get listenerCount() {
    return this.openListeners.size + this.closeListeners.size + this.errorListeners.size + this.messageListeners.size;
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
