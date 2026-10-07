import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTvDevices } from './useTvDevices.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
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
