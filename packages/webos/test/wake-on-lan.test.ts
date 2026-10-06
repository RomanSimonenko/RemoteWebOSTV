import { EventEmitter } from 'node:events';

import { describe, expect, test, vi } from 'vitest';

import {
  sendWakeOnLan,
  type WakeOnLanDependencies,
  type WakeSocket,
} from '../src/wake-on-lan.js';

class FakeWakeSocket extends EventEmitter implements WakeSocket {
  readonly packets: Buffer[] = [];
  readonly destinations: string[] = [];
  closed = false;
  closeError: Error | undefined;
  closeRequested = false;
  holdSend = false;
  sendError: Error | undefined;

  bind(callback: () => void): void {
    callback();
  }

  setBroadcast(_enabled: boolean): void {}

  send(
    packet: Buffer,
    _offset: number,
    _length: number,
    _port: number,
    _address: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.packets.push(Buffer.from(packet));
    this.destinations.push(_address);
    if (!this.holdSend) {
      callback(this.sendError);
    }
  }

  close(): void {
    if (this.closeError) {
      throw this.closeError;
    }
    this.closeRequested = true;
  }

  emitClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit('close');
  }
}

function createDependencies(socket: FakeWakeSocket): WakeOnLanDependencies {
  return {
    createSocket: (signal) => {
      signal.addEventListener('abort', () => socket.close(), { once: true });
      return socket;
    },
    schedule: (callback) => {
      callback();
      return undefined;
    },
    clearSchedule: () => undefined,
  };
}

describe('sendWakeOnLan', () => {
  test.each([undefined, '192.0.2.255'])('sends all magic packets to the configured destination %j', async (address) => {
    const socket = new FakeWakeSocket();
    const pending = sendWakeOnLan(['02:00:00:00:00:01'], new AbortController().signal, createDependencies(socket), address);
    socket.emitClose();
    await pending;
    expect(socket.destinations).toEqual(Array(3).fill(address ?? '255.255.255.255'));
    expect(socket.packets[0]).toHaveLength(102);
  });
  test.each([true, false])('UDP close failure has distinct cleanup provenance after send failure %j', async (sendFails) => {
    const socket = new FakeWakeSocket(); const cleanupCause = new Error('synthetic UDP cleanup'); socket.closeError = cleanupCause;
    const primary = new Error('synthetic UDP send'); if (sendFails) socket.sendError = primary;
    const captured = await sendWakeOnLan(['02:00:00:00:00:01'], new AbortController().signal, createDependencies(socket)).catch((cause: unknown) => cause);
    expect(captured).toMatchObject({ delivery: 'unknown', cause: { name: 'WebOsCleanupError' } });
    expect(((captured as Error).cause as AggregateError).errors).toEqual(sendFails ? [primary, cleanupCause] : [cleanupCause]);
    expect(socket.packets).toHaveLength(sendFails ? 1 : 3);
  });
  test('empty and invalid MAC inputs are not_sent before creating UDP resources', async () => {
    const socket = new FakeWakeSocket(); const dependencies = createDependencies(socket); const createSocket = vi.spyOn(dependencies, 'createSocket');
    await expect(sendWakeOnLan([], new AbortController().signal, dependencies)).rejects.toMatchObject({ delivery: 'not_sent', code: 'UNSUPPORTED_CAPABILITY' });
    await expect(sendWakeOnLan(['invalid'], new AbortController().signal, dependencies)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(createSocket).not.toHaveBeenCalled();
  });

  test('a synchronous send throw in an asynchronous bind callback is owned and cleaned up', async () => {
    const socket = new FakeWakeSocket(); let bound!: () => void;
    socket.bind = (callback) => { bound = callback; }; const cause = new Error('synthetic send throw'); socket.send = () => { throw cause; };
    const pending = sendWakeOnLan(['02:00:00:00:00:01'], new AbortController().signal, createDependencies(socket));
    expect(() => bound()).not.toThrow(); expect(socket.closeRequested).toBe(true); socket.emitClose();
    await expect(pending).rejects.toMatchObject({ delivery: 'unknown', cause });
  });
  test('UDP bind rejection is not_sent while send callback rejection is unknown and never retried', async () => {
    const before = new FakeWakeSocket(); before.bind = () => { throw new Error('synthetic bind'); };
    const preparing = sendWakeOnLan(['02:00:00:00:00:01'], new AbortController().signal, createDependencies(before)); before.emitClose();
    await expect(preparing).rejects.toMatchObject({ delivery: 'not_sent', cause: expect.any(Error) }); expect(before.packets).toHaveLength(0);
    const after = new FakeWakeSocket(); after.sendError = new Error('synthetic send');
    const sending = sendWakeOnLan(['02:00:00:00:00:01'], new AbortController().signal, createDependencies(after)); after.emitClose();
    await expect(sending).rejects.toMatchObject({ delivery: 'unknown', cause: after.sendError }); expect(after.packets).toHaveLength(1);
  });
  test('does not create a socket for an already cancelled operation', async () => {
    const createSocket = vi.fn(() => new FakeWakeSocket());
    const controller = new AbortController();
    controller.abort();

    await expect(
      sendWakeOnLan(['02:00:00:00:00:01'], controller.signal, {
        ...createDependencies(new FakeWakeSocket()),
        createSocket,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(createSocket).not.toHaveBeenCalled();
  });

  test('closes the active UDP socket when cancelled', async () => {
    const socket = new FakeWakeSocket();
    socket.holdSend = true;
    const controller = new AbortController();

    const pending = sendWakeOnLan(
      ['02:00:00:00:00:01'],
      controller.signal,
      createDependencies(socket),
    );
    expect(socket.packets).toHaveLength(1);
    controller.abort();

    expect(socket.closeRequested).toBe(true);
    socket.emitClose();
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(socket.closed).toBe(true);
  });

  test('sends three valid magic packets and closes the socket', async () => {
    const socket = new FakeWakeSocket();

    const pending = sendWakeOnLan(
      ['02:00:00:00:00:01'],
      new AbortController().signal,
      createDependencies(socket),
    );

    expect(socket.packets).toHaveLength(3);
    expect(socket.packets[0]).toHaveLength(102);
    expect(socket.packets[0]?.subarray(0, 6).toString('hex')).toBe(
      'ffffffffffff',
    );
    expect(socket.packets[0]?.subarray(6, 12).toString('hex')).toBe(
      '020000000001',
    );
    expect(socket.closeRequested).toBe(true);
    socket.emitClose();
    await pending;
    expect(socket.closed).toBe(true);
  });

  test('late cancellation overrides success before deferred close', async () => {
    const socket = new FakeWakeSocket();
    const controller = new AbortController();
    const pending = sendWakeOnLan(
      ['02:00:00:00:00:01'],
      controller.signal,
      createDependencies(socket),
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    expect(socket.packets).toHaveLength(3);
    expect(socket.closeRequested).toBe(true);
    controller.abort();

    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(false);

    socket.emitClose();
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });

  test('rejects when closing the UDP socket fails', async () => {
    const socket = new FakeWakeSocket();
    const closeError = new Error('synthetic close failure');
    socket.closeError = closeError;

    await expect(
      sendWakeOnLan(
        ['02:00:00:00:00:01'],
        new AbortController().signal,
        createDependencies(socket),
      ),
    ).rejects.toMatchObject({ delivery: 'unknown', cause: { name: 'WebOsCleanupError', cause: closeError } });
  });

  test('preserves an operational error when socket cleanup also fails', async () => {
    const socket = new FakeWakeSocket();
    const sendError = new Error('synthetic send failure');
    const closeError = new Error('synthetic close failure');
    socket.sendError = sendError;
    socket.closeError = closeError;

    let captured: unknown;
    try {
      await sendWakeOnLan(
        ['02:00:00:00:00:01'],
        new AbortController().signal,
        createDependencies(socket),
      );
    } catch (error) {
      captured = error;
    }

    expect((captured as Error).cause).toBeInstanceOf(AggregateError);
    expect(((captured as Error).cause as AggregateError).errors).toEqual([
      sendError,
      closeError,
    ]);
    expect(((captured as Error).cause as Error).cause).toBe(sendError);
  });
});
