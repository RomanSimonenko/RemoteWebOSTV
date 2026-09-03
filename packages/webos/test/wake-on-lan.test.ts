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
  holdSend = false;

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
      callback();
    }
  }

  close(): void {
    if (this.closeError) {
      throw this.closeError;
    }
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

    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(socket.closed).toBe(true);
  });

  test('sends three valid magic packets and closes the socket', async () => {
    const socket = new FakeWakeSocket();

    await sendWakeOnLan(
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
    expect(socket.closed).toBe(true);
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
});
