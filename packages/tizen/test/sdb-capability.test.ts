import { EventEmitter, getEventListeners } from 'node:events';
import { expect, test } from 'vitest';
import { readSdbPlatformVersion } from '../src/sdb-capability.js';
import { ManualScheduler } from './support/mock-samsung.js';

class Socket extends EventEmitter {
  frames: Buffer[] = [];
  destroyed = false;
  write(frame: Buffer) { this.frames.push(frame); return true; }
  destroy() { this.destroyed = true; return this; }
}
function frame(command: string, a0 = 0, a1 = 0, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(24), id = Buffer.from(command).readUInt32LE();
  [id, a0, a1, payload.length, payload.reduce((s, b) => s + b, 0), (~id) >>> 0].forEach((v, i) => header.writeUInt32LE(v, i * 4));
  return Buffer.concat([header, payload]);
}
function harness() {
  const socket = new Socket(), scheduler = new ManualScheduler(), controller = new AbortController();
  const pending = readSdbPlatformVersion('tv.invalid', controller.signal, { scheduler, timeoutMs: 500, createSocket: () => socket });
  socket.emit('connect');
  const connect = () => socket.emit('data', frame('CNXN', 0x0100000, 262144, Buffer.from('device::synthetic\0')));
  const capability = (text = 'platform_version:9.0\nprofile_name:tv\n') => {
    const bytes = Buffer.from(text), length = Buffer.alloc(2); length.writeUInt16LE(bytes.length);
    return frame('WRTE', 2, 1, Buffer.concat([length, bytes]));
  };
  const cleaned = () => { expect(socket.destroyed).toBe(true); expect(socket.eventNames()).toEqual([]); expect(scheduler.timers.size).toBe(0); expect(getEventListeners(controller.signal, 'abort')).toEqual([]); };
  return { socket, scheduler, controller, pending, connect, capability, cleaned };
}
test('reads fragmented capability version and discards unrelated private values', async () => {
  const h = harness(); h.connect();
  const bytes = h.capability('platform_version:9.0\nprofile_name:tv\ndevice_name:synthetic-private\n');
  h.socket.emit('data', bytes.subarray(0, 13)); h.socket.emit('data', bytes.subarray(13, 27)); h.socket.emit('data', bytes.subarray(27));
  expect(await h.pending).toEqual({ version: '9.0' });
  expect(h.socket.frames.map((b) => b.subarray(0, 4).toString())).toEqual(['CNXN', 'OPEN', 'OKAY', 'CLSE']);
  expect(h.socket.frames[1]!.subarray(24).toString()).toBe('capability:\0'); h.cleaned();
});
test('negotiates a newer peer protocol using the supported host version', async () => {
  const h = harness();
  h.socket.emit('data', frame('CNXN', 0x02000000, 262044, Buffer.from('device::synthetic\0')));
  h.socket.emit('data', h.capability());
  expect(await h.pending).toEqual({ version: '9.0' }); h.cleaned();
});
test.each(['AUTH', 'CLSE'])('rejects %s without authentication or another service', async (command) => {
  const h = harness(); h.connect(); h.socket.emit('data', frame(command));
  expect(await h.pending).toEqual({ diagnostic: { operation: 'sdb_capability', code: 'request_rejected' } });
  expect(h.socket.frames.map((b) => b.subarray(0, 4).toString())).toEqual(['CNXN', 'OPEN']); h.cleaned();
});
test.each(['magic', 'checksum', 'length', 'version', 'channel'])('rejects malformed %s', async (kind) => {
  const h = harness(); h.connect(); const bytes = h.capability();
  if (kind === 'magic') bytes.writeUInt32LE(0, 20);
  if (kind === 'checksum') bytes.writeUInt32LE(0, 16);
  if (kind === 'length') bytes.writeUInt32LE(262145, 12);
  if (kind === 'channel') bytes.writeUInt32LE(99, 8);
  h.socket.emit('data', kind === 'version' ? frame('CNXN', 0, 0) : bytes);
  expect(await h.pending).toEqual({ diagnostic: { operation: 'sdb_capability', code: 'invalid_response' } }); h.cleaned();
});
test.each(['', 'profile_name:mobile\nplatform_version:9.0\n', 'profile_name:tv\nplatform_version:\n', 'profile_name:tv\nplatform_version:9.0\nplatform_version:8.0\n'])('rejects unavailable or ambiguous version %j', async (text) => {
  const h = harness(); h.connect(); h.socket.emit('data', h.capability(text));
  expect((await h.pending).diagnostic?.operation).toBe('sdb_capability'); h.cleaned();
});
test('timeout closes a pending transport', async () => {
  const h = harness(); h.scheduler.fireAll(); expect(await h.pending).toEqual({ diagnostic: { operation: 'sdb_capability', code: 'timeout' } }); h.cleaned();
});
test('abort closes transport and ignores late reply', async () => {
  const h = harness(); h.connect(); h.controller.abort(); h.socket.emit('data', h.capability());
  await expect(h.pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' }); h.cleaned();
});
test.each(['error', 'close'])('%s is explicit sanitized unavailability', async (event) => {
  const h = harness(); h.socket.emit(event, new Error('synthetic private address'));
  expect(await h.pending).toEqual({ diagnostic: { operation: 'sdb_capability', code: 'request_rejected' } }); h.cleaned();
});
