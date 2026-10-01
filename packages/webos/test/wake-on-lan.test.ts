import { EventEmitter } from 'node:events';

import { describe, expect, test, vi } from 'vitest';

import {
  sendWakeOnLan,
  type WakeOnLanDependencies,
  type WakeSocket,
} from '../src/wake-on-lan.js';

class FakeWakeSocket extends EventEmitter implements WakeSocket {
  readonly packets: Buffer[] = [];
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
    ).rejects.toBe(closeError);
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

    expect(captured).toBeInstanceOf(AggregateError);
    expect((captured as AggregateError).errors).toEqual([
      sendError,
      closeError,
    ]);
    expect((captured as Error).cause).toBe(sendError);
  });
});
