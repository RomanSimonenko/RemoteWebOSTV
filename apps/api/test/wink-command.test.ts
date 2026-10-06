import { expect, test } from 'vitest';
import { barrier, drain, harness, succeed } from './support/tv-harness.js';
const input = { id: '15e082b2-de7e-4d86-a049-19c7448264f1', app: 'wink' } as const;
async function ready() { const h = harness(true); h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!); return h; }
test('launches the installed Wink id through the shared command lifecycle', async () => {
  const h = await ready(); const adapter = h.adapters[0]!;
  const launched: string[] = [];
  Object.assign(adapter, { listApps: async () => [{ id: 'synthetic.wink', name: 'Wink' }], launchApp: async (id: string) => { launched.push(id); } });
  expect(await h.service.sendCommand(input, new AbortController().signal)).toEqual({ id: input.id, outcome: 'sent' });
  expect(launched).toEqual(['synthetic.wink']); expect(adapter.sent).toEqual([]); await h.service.close();
});
test('missing or ambiguous Wink is rejected before launch', async () => {
  for (const apps of [[], [{ id: 'a', name: 'Wink' }, { id: 'b', name: 'Wink' }], [{ id: 'c', name: 'Wink impostor' }]]) {
    const h = await ready(); const launched: string[] = [];
    Object.assign(h.adapters[0]!, { listApps: async () => apps, launchApp: async (id: string) => { launched.push(id); } });
    expect(await h.service.sendCommand(input, new AbortController().signal)).toMatchObject({ outcome: 'rejected', error: { code: 'APP_NOT_AVAILABLE' } });
    expect(launched).toEqual([]); await h.service.close();
  }
});
test('cancellation while listing apps never launches Wink', async () => {
  const h = await ready(); const apps = barrier<readonly { id: string; name: string }[]>(); const launched: string[] = [];
  Object.assign(h.adapters[0]!, { listApps: () => apps.promise, launchApp: async (id: string) => { launched.push(id); } });
  const controller = new AbortController(); const pending = h.service.sendCommand(input, controller.signal); await drain(); controller.abort();
  await pending; apps.resolve([{ id: 'synthetic.wink', name: 'Wink' }]); await drain();
  expect(launched).toEqual([]); await h.service.close();
});
test('lost launch result remains unknown and is not retried', async () => {
  const h = await ready(); let count = 0;
  Object.assign(h.adapters[0]!, { listApps: async () => [{ id: 'synthetic.wink', name: 'Wink' }], launchApp: async () => { count++; throw new Error('private'); } });
  expect(await h.service.sendCommand(input, new AbortController().signal)).toMatchObject({ outcome: 'unknown' });
  expect(count).toBe(1); await h.service.close();
});
test('listing failure is explicit and never launches the app', async () => {
  const h = await ready(); let launches = 0;
  Object.assign(h.adapters[0]!, { listApps: async () => { throw new Error('private network detail'); }, launchApp: async () => { launches++; } });
  expect(await h.service.sendCommand(input, new AbortController().signal)).toMatchObject({ outcome: 'rejected', error: { code: 'APP_LIST_UNAVAILABLE' } });
  expect(launches).toBe(0); await h.service.close();
});
test('an uncertain launch keeps commands blocked and shutdown waits for its owner', async () => {
  const h = await ready(); const entered = barrier<void>(); const result = barrier<void>();
  Object.assign(h.adapters[0]!, { listApps: async () => [{ id: 'synthetic.wink', name: 'Wink' }], launchApp: async () => { entered.resolve(); await result.promise; } });
  const controller = new AbortController(); const pending = h.service.sendCommand(input, controller.signal); await entered.promise; controller.abort();
  expect(await pending).toMatchObject({ outcome: 'unknown' });
  expect(h.service.remoteState()).toEqual({ enabled: false, reason: 'BUSY' });
  expect(await h.service.sendCommand({ id: input.id, button: 'HOME' }, new AbortController().signal)).toMatchObject({ outcome: 'rejected', error: { code: 'TV_BUSY' } });
  let closed = false; const closing = h.service.close().then(() => { closed = true; }); await drain(); expect(closed).toBe(false);
  result.resolve(); await closing; expect(closed).toBe(true);
});
