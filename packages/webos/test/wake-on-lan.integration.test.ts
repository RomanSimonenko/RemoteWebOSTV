import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { sendWakeOnLan, type WakeSocket } from '../src/wake-on-lan.js';

type Receiver = EventEmitter & {
  bind(port: number, address: string): unknown;
  address(): string | AddressInfo;
  close(callback: () => void): unknown;
};
interface Deadline { schedule(run: () => void): unknown; clear(handle: unknown): void }
const realDeadline: Deadline = {
  schedule: (run) => setTimeout(run, 1500),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function receiveBurst(receiver: Receiver, send: (port: number, signal: AbortSignal) => Promise<void>, deadline: Deadline = realDeadline) {
  const packets: Buffer[] = [];
  const controller = new AbortController();
  let sending: Promise<void> | undefined;
  let timer: unknown;
  let failure: unknown;
  let onMessage!: (packet: Buffer) => void;
  let onError!: (error: Error) => void;
  let onListening!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      let sent = false;
      const complete = () => { if (sent && packets.length === 3) resolve(); };
      onMessage = (packet) => { packets.push(Buffer.from(packet)); complete(); };
      onError = reject;
      onListening = () => {
        try {
          sending = send((receiver.address() as AddressInfo).port, controller.signal);
          void sending.then(() => { sent = true; complete(); }, reject);
        } catch (cause) { reject(cause); }
      };
      receiver.on('message', onMessage);
      receiver.on('error', onError);
      receiver.once('listening', onListening);
      timer = deadline.schedule(() => reject(new Error(`UDP receive deadline expired: received ${packets.length} of 3 packets`)));
      receiver.bind(0, '127.0.0.1');
    });
  } catch (cause) { failure = cause; }
  finally {
    deadline.clear(timer);
    controller.abort(failure);
    receiver.off('message', onMessage);
    receiver.off('listening', onListening);
    const closed = new Promise<void>((resolve, reject) => {
      try { receiver.close(resolve); }
      catch (cause) {
        // A failed bind can leave no socket to close; this is explicit dgram lifecycle state.
        if ((cause as NodeJS.ErrnoException).code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve();
        else reject(cause);
      }
    });
    const cleanup = await Promise.allSettled([sending, closed]);
    receiver.off('error', onError);
    const errors = cleanup.flatMap((result) => result.status === 'rejected' && result.reason !== failure ? [result.reason] : []);
    if (errors.length) failure = new AggregateError([...(failure === undefined ? [] : [failure]), ...errors], 'UDP test cleanup failed');
  }
  if (failure !== undefined) throw failure;
  return packets;
}

class ControlledReceiver extends EventEmitter implements Receiver {
  closed = false;
  bindError: Error | undefined;
  bind() { this.emit(this.bindError ? 'error' : 'listening', this.bindError); }
  address(): AddressInfo { return { address: '127.0.0.1', family: 'IPv4', port: 1 }; }
  close(callback: () => void) { this.closed = true; callback(); }
}

function controlledDeadline() {
  let run: (() => void) | undefined;
  let active = false;
  return {
    get active() { return active; },
    expire() { if (!run) throw new Error('Receive deadline was not scheduled'); run(); },
    schedule(callback: () => void) { run = callback; active = true; return callback; },
    clear() { active = false; },
  };
}

test('missing packet rejects on the controlled deadline and closes receiver without remaining listeners', async () => {
  const receiver = new ControlledReceiver(); const deadline = controlledDeadline();
  const pending = receiveBurst(receiver, async () => { receiver.emit('message', Buffer.alloc(102)); receiver.emit('message', Buffer.alloc(102)); }, deadline);
  try {
    expect(deadline.active).toBe(true);
    const rejected = expect(pending).rejects.toThrow('UDP receive deadline expired: received 2 of 3 packets');
    deadline.expire(); await rejected;
    expect(receiver.closed).toBe(true);
    expect(deadline.active).toBe(false);
    expect(receiver.eventNames()).toEqual([]);
  } finally { receiver.close(() => undefined); }
});

test('receiver error rejects with its original cause and releases receiver and deadline', async () => {
  const receiver = new ControlledReceiver(); const deadline = controlledDeadline();
  const pending = receiveBurst(receiver, async () => undefined, deadline);
  try {
    expect(deadline.active).toBe(true);
    const cause = new Error('synthetic UDP receiver error'); const rejected = expect(pending).rejects.toBe(cause);
    receiver.emit('error', cause); await rejected;
    expect(receiver.closed).toBe(true);
    expect(deadline.active).toBe(false);
    expect(receiver.eventNames()).toEqual([]);
  } finally { receiver.close(() => undefined); }
});

test('binding failure is owned by cleanup before listening', async () => {
  const receiver = new ControlledReceiver(); const deadline = controlledDeadline();
  const cause = new Error('synthetic UDP bind failure'); receiver.bindError = cause;
  try {
    await expect(receiveBurst(receiver, async () => undefined, deadline)).rejects.toBe(cause);
    expect(receiver.closed).toBe(true);
    expect(deadline.active).toBe(false);
    expect(receiver.eventNames()).toEqual([]);
  } finally { receiver.close(() => undefined); }
});

test('real UDP loopback receives the complete three-packet burst and sender closes', async () => {
  const receiver = dgram.createSocket('udp4');
  let closed = false;
  const packets = await receiveBurst(receiver, async (port, signal) => {
    await sendWakeOnLan(['02:00:00:00:00:03'], signal, {
      createSocket: (signal) => {
        const sender = dgram.createSocket({ type: 'udp4', signal });
        sender.once('close', () => { closed = true; });
        // Override destination only: real bind, UDP send, callbacks and close.
        const send = sender.send.bind(sender);
        sender.send = ((packet: Buffer, offset: number, length: number, _port: number, _address: string, callback: (error: Error | null) => void) => {
          send(packet, offset, length, port, '127.0.0.1', callback);
        }) as typeof sender.send;
        return sender as WakeSocket;
      },
      schedule: (callback, delay) => setTimeout(callback, delay),
      clearSchedule: (timer) => clearTimeout(timer),
    });
  });
  expect(closed).toBe(true);
  expect(packets).toHaveLength(3);
  for (const packet of packets) {
    expect(packet.length).toBe(102);
    expect(packet.subarray(0, 6).toString('hex')).toBe('ffffffffffff');
    expect(packet.subarray(6).toString('hex')).toBe('020000000003'.repeat(16));
  }
});
