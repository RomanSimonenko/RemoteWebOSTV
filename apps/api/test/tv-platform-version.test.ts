import { expect, test, vi } from 'vitest';
import type { PlatformVersionResult } from '@remote-webos-tv/webos';
import { ControlledAdapter, barrier, drain, harness, pairing, snapshot, succeed } from './support/tv-harness.js';

function versionHarness() {
  const result = barrier<PlatformVersionResult>();
  const entered = barrier<AbortSignal>();
  const diagnostics: unknown[] = [];
  const adapters: ControlledAdapter[] = [];
  const h = harness(false, {
    onVersionDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
    createAdapter(_host, staging) {
      const adapter = Object.assign(new ControlledAdapter(staging), {
        readPlatformVersion(signal: AbortSignal) { entered.resolve(signal); return result.promise; },
      });
      adapters.push(adapter); return adapter;
    },
  });
  return { ...h, adapters, result, entered, diagnostics };
}

test('optional platform metadata persists without delaying availability or remote commands', async () => {
  const h = versionHarness();
  try {
    h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
    expect(h.service.remoteState()).toEqual({ enabled: true, reason: null, apps: true });
    expect((await h.service.status()).operation?.status).toBe('succeeded');
    expect(await h.service.sendCommand({ id: '15e082b2-de7e-4d86-a049-19c7448264f1', button: 'HOME' }, new AbortController().signal))
      .toEqual({ id: '15e082b2-de7e-4d86-a049-19c7448264f1', outcome: 'sent' });
    const original = h.repository.load()!;
    h.service.setMac('02:00:00:00:00:03');
    h.result.resolve({ version: '6.5.3' }); await drain();
    expect(h.repository.load()).toEqual({ ...original, macAddress: '02:00:00:00:00:03', identity: { model: 'Synthetic Model', platformVersion: '6.5.3' } });
    expect(h.writes).toHaveLength(3);
  } finally { await h.service.close(); }
});

test.each(['timeout', 'invalid_response', 'version_unavailable', 'request_rejected', 'send_failed'] as const)('optional metadata %s stays available and emits a safe diagnostic', async (code) => {
  const h = versionHarness();
  try {
    h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
    h.result.resolve({ diagnostic: { operation: 'hello', code } }); await drain();
    expect(h.diagnostics).toEqual([{ operation: 'hello', code }]);
    expect(h.writes).toHaveLength(1);
    expect(h.service.remoteState()).toEqual({ enabled: true, reason: null, apps: true });
  } finally { await h.service.close(); }
});

test('close aborts metadata and its late success cannot write storage', async () => {
  const h = versionHarness();
  h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
  const signal = await h.entered.promise;
  await h.service.close();
  expect(signal.aborted).toBe(true);
  h.result.resolve({ version: '6.5.3' }); await drain();
  expect(h.writes).toHaveLength(1);
});

test('address replacement aborts metadata and ignores the previous connection late outcome', async () => {
  const h = versionHarness();
  try {
    h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
    const signal = await h.entered.promise;
    h.service.start({ action: 'change_address', host: '192.168.1.11' }); await drain();
    expect(signal.aborted).toBe(true);
    h.result.resolve({ version: '6.5.3' }); await drain();
    expect(h.writes).toHaveLength(1);
    const adapter = h.adapters[1]!;
    adapter.pairResult.resolve({ ...pairing, identity: { model: 'Replacement', platformVersion: '7.0' } });
    adapter.readResult.resolve(snapshot); await drain();
    expect(h.repository.load()?.identity).toEqual({ model: 'Replacement', platformVersion: '7.0' });
  } finally { await h.service.close(); }
});

test('reconnect retains known optional version and MAC when registration omits version', async () => {
  const base = harness(true);
  base.repository.replace({ ...base.repository.load()!, identity: { model: 'Synthetic Model', platformVersion: '6.5.3' }, macAddress: '02:00:00:00:00:03' });
  const h = harness(true, { repository: base.repository });
  try {
    h.service.start({ action: 'reconnect' }); await drain(); await succeed(h.adapters[0]!);
    expect(base.repository.load()?.identity.platformVersion).toBe('6.5.3');
    expect(base.repository.load()?.macAddress).toBe('02:00:00:00:00:03');
  } finally { await h.service.close(); await base.service.close(); }
});

test('metadata persistence failure remains observable without disabling remote', async () => {
  const h = versionHarness();
  try {
    h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
    h.repository.replace = () => { throw new Error('private storage path'); };
    h.result.resolve({ version: '6.5.3' }); await drain();
    expect(h.diagnostics).toEqual([{ operation: 'hello', code: 'storage_failed' }]);
    expect(h.repository.load()?.identity.platformVersion).toBeUndefined();
    expect(h.service.remoteState()).toEqual({ enabled: true, reason: null, apps: true });
  } finally { await h.service.close(); }
});

test.each([null, undefined, {}, { version: '' }, { version: 65 }, { diagnostic: { operation: 'hello', code: 'private raw key' } }, { version: '6.5.3', diagnostic: { operation: 'hello', code: 'timeout' } }])('malformed metadata is rejected safely: %j', async (result) => {
  const h = versionHarness();
  try {
    h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
    h.result.resolve(result as unknown as PlatformVersionResult); await drain();
    expect(h.diagnostics).toEqual([{ operation: 'hello', code: 'invalid_response' }]);
    expect(h.writes).toHaveLength(1);
    expect(h.service.remoteState().enabled).toBe(true);
  } finally { await h.service.close(); }
});

test.each([{ model: 'Replacement' }, { model: 'Synthetic Model', firmwareVersion: 'new-firmware' }])('reconnect does not carry a known version across changed identity: %j', async (identity) => {
  const base = harness(true);
  base.repository.replace({ ...base.repository.load()!, identity: { model: 'Synthetic Model', platformVersion: '6.5.3' }, macAddress: '02:00:00:00:00:03' });
  const h = harness(true, { repository: base.repository });
  try {
    h.service.start({ action: 'reconnect' }); await drain();
    const adapter = h.adapters[0]!;
    adapter.pairResult.resolve({ ...pairing, identity }); adapter.readResult.resolve(snapshot); await drain();
    expect(base.repository.load()?.identity.platformVersion).toBeUndefined();
    expect(base.repository.load()?.macAddress).toBeNull();
  } finally { await h.service.close(); await base.service.close(); }
});

test('known registration version skips optional acquisition and remains unchanged', async () => {
  const h = versionHarness();
  try {
    h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    const adapter = h.adapters[0]!;
    adapter.pairResult.resolve({ ...pairing, identity: { model: 'Synthetic Model', platformVersion: '7.0' } });
    adapter.readResult.resolve(snapshot); await drain();
    h.result.resolve({ version: '6.5.3' }); await drain();
    expect(h.repository.load()?.identity.platformVersion).toBe('7.0');
    expect(h.writes).toHaveLength(1);
    expect(h.service.remoteState().enabled).toBe(true);
  } finally { await h.service.close(); }
});

test('service budget aborts metadata that ignores cancellation and discards a late rejection', async () => {
  const h = versionHarness();
  try {
    h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
    const signal = await h.entered.promise;
    h.scheduler.advance(5_000); await drain();
    expect(signal.aborted).toBe(true);
    expect(h.diagnostics).toEqual([{ operation: 'hello', code: 'timeout' }]);
    h.result.reject(new Error('private network address')); await drain();
    expect(h.writes).toHaveLength(1);
    expect(h.service.remoteState().enabled).toBe(true);
  } finally { await h.service.close(); }
});

test('metadata read rejection is safe and a broken diagnostic sink stays observable', async () => {
  const safeLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const h = versionHarness();
  let failedAdapter: ControlledAdapter;
  const failed = harness(false, {
    createAdapter(_host, staging) {
      failedAdapter = Object.assign(new ControlledAdapter(staging), { readPlatformVersion: () => Promise.reject(new Error('private network key')) });
      return failedAdapter;
    },
    onVersionDiagnostic() { throw new Error('private sink message'); },
  });
  try {
    h.service.start({ action: 'pair', host: '192.168.1.10' }); await drain(); await succeed(h.adapters[0]!);
    h.result.reject(new Error('private key')); await drain();
    expect(h.diagnostics).toEqual([{ operation: 'hello', code: 'read_failed' }]);
    expect(h.service.remoteState().enabled).toBe(true);
    failed.service.start({ action: 'pair', host: '192.168.1.10' }); await drain();
    await succeed(failedAdapter!);
    expect(failed.service.remoteState().enabled).toBe(true);
    expect(safeLog.mock.calls).toEqual([[{ operation: 'hello', code: 'diagnostic_failed' }, 'Optional TV metadata diagnostic failed']]);
  } finally { await h.service.close(); await failed.service.close(); safeLog.mockRestore(); }
});
