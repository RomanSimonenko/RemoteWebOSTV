import { describe, expect, test } from 'vitest';
import { TvButtonSendError } from '@remote-webos-tv/webos';
import { barrier, drain, harness, snapshot, succeed } from './support/tv-harness.js';

const input = { id: '15e082b2-de7e-4d86-a049-19c7448264f1', button: 'HOME' } as const;
const signal = () => new AbortController().signal;
async function ready() {
  const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!); return h;
}

describe('TV commands', () => {
  test('invalid runtime requests fail strict validation before adapter use', async () => {
    const h = await ready();
    for (const value of [{ ...input, button: 'EXIT' }, { ...input, extra: true }, { ...input, id: '' }]) {
      expect(() => h.service.assertCanSendCommand(value as typeof input)).toThrowError(expect.objectContaining({ statusCode: 400 }));
      await expect(h.service.sendCommand(value as typeof input, signal())).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(h.adapters[0]!.sent).toEqual([]); await h.service.close();
  });

  test('an existing status probe owns adapter cleanup and blocks command admission', async () => {
    const h = await ready(); const adapter = h.adapters[0]!; adapter.readResult = barrier();
    const reading = h.service.status();
    expect(await h.service.sendCommand(input, signal())).toMatchObject({ outcome: 'rejected', error: { code: 'TV_BUSY' } });
    expect(adapter.sent).toEqual([]); adapter.readResult.resolve(snapshot); await reading; await h.service.close();
  });

  test('replacement invalidates old capability and late probe cannot enable new remote', async () => {
    const h = await ready(); const old = h.adapters[0]!; old.readResult = barrier(); const reading = h.service.status();
    h.service.start({ action: 'repair' }); await drain();
    old.readResult.resolve(snapshot); await reading; await drain();
    expect(h.service.remoteState().enabled).toBe(false);
    expect(await h.service.sendCommand(input, signal())).toMatchObject({ outcome: 'rejected', error: { code: 'TV_BUSY' } });
    const next = h.adapters[1]!; next.pairResult.resolve({ clientKey: 'synthetic-key', identity: snapshot.identity!, capabilities: snapshot.capabilities, transport: 'ws:3000', macAddresses: [] });
    await next.enteredRead.promise; next.readResult.resolve({ ...snapshot, capabilities: { ...snapshot.capabilities, pointer: false } }); await drain();
    expect(h.service.remoteState()).toEqual({ enabled: false, reason: 'UNSUPPORTED' }); expect(old.sent).toEqual([]); expect(next.sent).toEqual([]); await h.service.close();
  });

  test('monotonic deadline rejects a late completion even before timer delivery', async () => {
    const h = await ready(); const adapter = h.adapters[0]!; const gate = barrier<void>(); adapter.sendResult = gate.promise;
    const pending = h.service.sendCommand(input, signal()); await adapter.enteredSend.promise;
    h.scheduler.time = 5000; gate.resolve();
    expect(await pending).toMatchObject({ outcome: 'unknown', error: { code: 'COMMAND_RESULT_UNKNOWN' } });
    await h.service.close();
  });

  test('unclassified adapter failure remains unknown and is never retried', async () => {
    const h = await ready(); const adapter = h.adapters[0]!; adapter.sendResult = Promise.reject(new Error('private message'));
    expect(await h.service.sendCommand(input, signal())).toMatchObject({ outcome: 'unknown', error: { code: 'COMMAND_RESULT_UNKNOWN' } });
    expect(adapter.sent).toEqual(['HOME']); await h.service.close();
  });

  test('offline and lifecycle conflict reject before touching the adapter', async () => {
    const h = harness(true);
    expect(h.service.remoteState()).toEqual({ enabled: false, reason: 'UNAVAILABLE' });
    expect(await h.service.sendCommand(input, signal())).toMatchObject({ id: input.id, outcome: 'rejected', error: { code: 'TV_UNAVAILABLE' } });
    h.service.start({ action: 'reconnect' }); await drain();
    expect(await h.service.sendCommand(input, signal())).toMatchObject({ outcome: 'rejected', error: { code: 'TV_BUSY' } });
    expect(h.adapters[0]!.sent).toEqual([]); await h.service.close();
  });

  test.each([false, undefined])('fails closed when current pointer capability is %s', async (pointer) => {
    const h = await ready(); const adapter = h.adapters[0]!;
    adapter.readResult = barrier(); const reading = h.service.status(); await drain();
    adapter.readResult.resolve({ ...snapshot, capabilities: { ...snapshot.capabilities, pointer } } as typeof snapshot); await reading;
    expect(h.service.remoteState().enabled).toBe(false);
    expect(await h.service.sendCommand(input, signal())).toMatchObject({ outcome: 'rejected' });
    expect(adapter.sent).toEqual([]); await h.service.close();
  });

  test('one synchronous admission blocks a second command and lifecycle operations', async () => {
    const h = await ready(); const adapter = h.adapters[0]!; const gate = barrier<void>(); adapter.sendResult = gate.promise;
    const first = h.service.sendCommand(input, signal());
    expect(h.service.remoteState()).toEqual({ enabled: false, reason: 'BUSY' });
    expect(await h.service.sendCommand({ ...input, button: 'UP' }, signal())).toMatchObject({ outcome: 'rejected', error: { code: 'TV_BUSY' } });
    expect(() => h.service.start({ action: 'repair' })).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    await adapter.enteredSend.promise; gate.resolve(); expect(await first).toEqual({ id: input.id, outcome: 'sent' });
    expect(adapter.sent).toEqual(['HOME']); expect(h.service.remoteState()).toEqual({ enabled: true, reason: null }); await h.service.close();
  });

  test.each(['abort', 'close'] as const)('%s before deferred send prevents transport use', async (ending) => {
    const h = await ready(); const controller = new AbortController(); const pending = h.service.sendCommand(input, controller.signal);
    const closing = ending === 'close' ? h.service.close() : undefined; if (ending === 'abort') controller.abort();
    expect(await pending).toMatchObject({ outcome: 'rejected', error: { code: 'COMMAND_NOT_SENT' } });
    expect(h.adapters[0]!.sent).toEqual([]); await closing; await h.service.close();
  });

  test('5000ms monotonic budget bounds the response but owns late work until settlement', async () => {
    const h = await ready(); const adapter = h.adapters[0]!; const gate = barrier<void>(); adapter.sendResult = gate.promise;
    let result: unknown; const pending = h.service.sendCommand(input, signal()).then((value) => { result = value; });
    const sendingSignal = await adapter.enteredSend.promise; h.setEpoch(0); h.scheduler.advance(4999); await drain(); expect(result).toBeUndefined();
    h.scheduler.advance(1); await pending; expect(result).toMatchObject({ id: input.id, outcome: 'unknown', error: { code: 'COMMAND_RESULT_UNKNOWN' } }); expect(sendingSignal.aborted).toBe(true);
    expect(() => h.service.start({ action: 'reconnect' })).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    let closed = false; const closing = h.service.close().then(() => { closed = true; }); await drain(); expect(closed).toBe(false);
    gate.resolve(); await closing; expect(adapter.sent).toEqual(['HOME']);
  });

  test.each(['not_sent', 'unknown'] as const)('normalizes delivery %s without leaking cause or retrying', async (delivery) => {
    const h = await ready(); const adapter = h.adapters[0]!;
    adapter.sendResult = Promise.reject(new TvButtonSendError('CONNECTION_LOST', delivery, 'private transport', { cause: new Error('private cause') }));
    const result = await h.service.sendCommand(input, signal());
    expect(result).toMatchObject({ id: input.id, outcome: delivery === 'not_sent' ? 'rejected' : 'unknown', error: { code: delivery === 'not_sent' ? 'COMMAND_NOT_SENT' : 'COMMAND_RESULT_UNKNOWN' } });
    expect(JSON.stringify(result)).not.toContain('private'); expect(adapter.sent).toEqual(['HOME']); await h.service.close();
  });

  test('unsupported pointer failure disables remote while preserving SSAP availability', async () => {
    const h = await ready(); const adapter = h.adapters[0]!;
    adapter.sendResult = Promise.reject(new TvButtonSendError('POINTER_FORBIDDEN', 'not_sent', 'private'));
    expect(await h.service.sendCommand(input, signal())).toMatchObject({ outcome: 'rejected', error: { code: 'UNSUPPORTED_CAPABILITY' } });
    expect(h.service.remoteState()).toEqual({ enabled: false, reason: 'UNSUPPORTED' });
    adapter.readResult = barrier(); const reading = h.service.status(); adapter.readResult.resolve({ ...snapshot, capabilities: { ...snapshot.capabilities, pointer: false } });
    expect((await reading).connection).toBe('available'); expect(adapter.closed).toBe(false); await h.service.close();
  });

  test('status cannot replace capability data or disconnect during a command', async () => {
    const h = await ready(); const adapter = h.adapters[0]!; const gate = barrier<void>(); adapter.sendResult = gate.promise;
    const sending = h.service.sendCommand(input, signal()); await adapter.enteredSend.promise;
    expect((await h.service.status()).connection).toBe('available'); expect(adapter.reads).toBe(1);
    gate.resolve(); await sending; await h.service.close();
  });
});
