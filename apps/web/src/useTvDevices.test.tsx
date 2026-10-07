import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTvDevices } from './useTvDevices.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
test.each(['success', 'failure'])('a stale list %s cannot resurrect a deleted TV or its error', async (outcome) => {
  vi.useFakeTimers();
  const tvId = '00000000-0000-4000-8000-000000000001';
  const devices = [{ tvId, platform: 'webos', status: { tv: { host: '10.2.3.4', identity: { model: 'Synthetic TV' } }, connection: 'unavailable', operation: null } }];
  let resolve!: (response: Response) => void; let reject!: (cause: unknown) => void;
  const pending = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ devices }))).mockReturnValueOnce(pending));
  const { result } = renderHook(() => useTvDevices(vi.fn())); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  act(() => result.current.remove(tvId));
  await act(async () => { if (outcome === 'success') resolve(new Response(JSON.stringify({ devices }))); else reject(new Error('synthetic stale failure')); });
  expect(result.current.devices).toEqual([]); expect(result.current.error).toBe('');
});
test('list failures stay distinct from an empty list', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
  const { result } = renderHook(() => useTvDevices(vi.fn()));
  await act(async () => {});
  expect(result.current.devices).toBeNull();
  expect(result.current.error).toContain('Нет связи');
});
test('disabled list does not poll and ignores a late response', async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal('fetch', fetch);
  const { result, rerender } = renderHook(({ enabled }) => useTvDevices(vi.fn(), enabled), { initialProps: { enabled: true } });
  rerender({ enabled: false });
  await act(async () => { resolve(new Response(JSON.stringify({ devices: [] }))); });
  expect(result.current.devices).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
