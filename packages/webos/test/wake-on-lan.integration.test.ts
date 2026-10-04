import dgram from 'node:dgram';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { sendWakeOnLan, type WakeSocket } from '../src/wake-on-lan.js';

test('real UDP loopback receives the complete three-packet burst and sender closes', async () => {
  const receiver = dgram.createSocket('udp4');
  const packets: Buffer[] = [];
  let received!: () => void;
  const allReceived = new Promise<void>((resolve) => { received = resolve; });
  receiver.on('message', (packet) => { packets.push(Buffer.from(packet)); if (packets.length === 3) received(); });
  receiver.bind(0, '127.0.0.1');
  await once(receiver, 'listening');
  const port = (receiver.address() as AddressInfo).port;
  let closed = false;
  try {
    await sendWakeOnLan(['02:00:00:00:00:03'], new AbortController().signal, {
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
    await allReceived;
    expect(closed).toBe(true);
    expect(packets).toHaveLength(3);
    for (const packet of packets) {
      expect(packet.length).toBe(102);
      expect(packet.subarray(0, 6).toString('hex')).toBe('ffffffffffff');
      expect(packet.subarray(6).toString('hex')).toBe('020000000003'.repeat(16));
    }
  } finally {
    await new Promise<void>((resolve) => receiver.close(resolve));
  }
});
