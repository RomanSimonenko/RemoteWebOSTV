import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTvStatus } from './useTvStatus.js';

const available = { tv: { host: '192.168.1.20', identity: { model: 'Synthetic TV' } }, connection: 'available', operation: null };
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function barrier<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test('polls after at least two seconds and coalesces manual refresh without overlapping a slow read', async () => {
  vi.useFakeTimers();
  const first = barrier<Response>();
  const second = barrier<Response>();
  const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(response(available));
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useTvStatus(vi.fn()));
  expect(result.current.loading).toBe(true);
  expect(result.current.getReadVersion()).toBe(1);
  act(() => { result.current.refresh(); result.current.refresh(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { first.resolve(response(available)); });
  expect(result.current.status?.connection).toBe('available');
  expect(result.current.loading).toBe(false);
  expect(result.current.statusReadVersion).toBe(1);
  act(() => result.current.refresh());
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.current.loading).toBe(false);
  expect(result.current.getReadVersion()).toBe(2);
  expect(result.current.statusReadVersion).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { second.resolve(response(available)); });
  expect(result.current.statusReadVersion).toBe(2);
});

test('a failed initial read ends loading and recovers through a background read without becoming busy again', async () => {
  vi.useFakeTimers();
  const initial = barrier<Response>();
  const recovery = barrier<Response>();
  const fetch = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(recovery.promise);
  vi.stubGlobal('fetch', fetch);
  const { result, unmount } = renderHook(() => useTvStatus(vi.fn()));
  expect(result.current.loading).toBe(true);
  await act(async () => { initial.resolve(response({ code: 'UNAVAILABLE', message: 'Synthetic failure', requestId: 'synthetic' }, 503)); });
  expect(result.current.loading).toBe(false);
  expect(result.current.status).toBeNull();
  expect(result.current.error).not.toBe('');
  const error = result.current.error;
  act(() => result.current.refresh());
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBe(error);
  await act(async () => { recovery.resolve(response(available)); });
  expect(result.current.status?.connection).toBe('available');
  expect(result.current.error).toBe('');
  expect(result.current.loading).toBe(false);
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each(['initial', 'background'])('unmount aborts the active %s read and ignores a late unauthorized response', async (phase) => {
  vi.useFakeTimers();
  const pending = barrier<Response>();
  const fetch = vi.fn();
  if (phase === 'background') fetch.mockResolvedValueOnce(response(available));
  fetch.mockReturnValue(pending.promise);
  const expired = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { unmount } = renderHook(() => useTvStatus(expired));
  if (phase === 'background') {
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  }
  const expectedReads = phase === 'background' ? 2 : 1;
  const signal = fetch.mock.calls[expectedReads - 1]![1].signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401)); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(expired).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(expectedReads);
});

test('a failed refresh clears stale availability and retains a visible error until a successful read', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(response(available)).mockRejectedValueOnce(new Error('synthetic network failure')).mockResolvedValue(response(available));
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useTvStatus(vi.fn()));
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.error).toContain('Нет связи');
  expect(result.current.status?.connection).not.toBe('available');
  act(() => result.current.refresh());
  expect(result.current.error).toContain('Нет связи');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.error).toBe('');
  expect(result.current.status?.connection).toBe('available');
});

test.each(['initial', 'background'])('401 during the %s read expires the session and stops further polling', async (phase) => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const fetch = vi.fn();
  if (phase === 'background') fetch.mockResolvedValueOnce(response(available));
  fetch.mockResolvedValue(response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401));
  vi.stubGlobal('fetch', fetch);
  renderHook(() => useTvStatus(expired));
  await act(async () => {});
  if (phase === 'background') await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(expired).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(fetch).toHaveBeenCalledTimes(phase === 'background' ? 2 : 1);
});
