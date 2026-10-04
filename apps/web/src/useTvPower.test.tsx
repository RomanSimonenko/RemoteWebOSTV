import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiFailure } from './api.js';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTvPower } from './useTvPower.js';

const id = '00000000-0000-4000-8000-000000000001';
const operation = { id, action: 'wake', status: 'running', phase: 'sending', delivery: 'not_sent', startedAt: 10000, deadlineAt: 70000 };
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
const state = { mac: '02:00:00:00:00:01', canWake: true, canPowerOff: false, operation: null };
function barrier<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test('power API strictly parses public state and rejects secret-bearing responses', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ mac: null, canWake: false, canPowerOff: false, operation: null, clientKey: 'synthetic' })));
  expect(api).toHaveProperty('powerState');
  await expect(api.powerState()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

test('power reads are sequential with a completion cooldown, stable background loading and coalesced refresh', async () => {
  vi.useFakeTimers(); const first = barrier<Response>(); const second = barrier<Response>();
  const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(response(state)); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useTvPower(true, 'synthetic', vi.fn()));
  expect(result.current.loading).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
  act(() => { result.current.refresh(); result.current.refresh(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { first.resolve(response(state)); }); expect(result.current.loading).toBe(false);
  act(() => result.current.refresh()); await act(async () => { await vi.advanceTimersByTimeAsync(1999); }); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(fetch).toHaveBeenCalledTimes(2); expect(result.current.loading).toBe(false);
  act(() => result.current.refresh()); await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { second.resolve(response(state)); }); expect(result.current.state).toEqual(state);
});

test('an older read cannot resurrect a running operation after successful cancel, but a fresh read can show another tab', async () => {
  vi.useFakeTimers(); const read = barrier<Response>(); const other = { ...operation, id: '00000000-0000-4000-8000-000000000002' };
  const fetch = vi.fn().mockResolvedValueOnce(response({ ...state, canWake: false, operation })).mockReturnValueOnce(read.promise)
    .mockResolvedValueOnce(response({ ...operation, status: 'cancelled', phase: 'finished' })).mockResolvedValue(response({ ...state, canWake: false, operation: other })); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useTvPower(true, 'synthetic', vi.fn())); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  act(() => result.current.cancel(id)); await act(async () => {});
  await act(async () => { read.resolve(response({ ...state, canWake: false, operation })); }); expect(result.current.state?.operation?.status).toBe('cancelled');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(result.current.state?.operation?.id).toBe(other.id);
});

test.each(['unmount', 'inactive', 'new-session'])('%s aborts reads and mutation and ignores late responses', async (mode) => {
  vi.useFakeTimers(); const read = barrier<Response>(); const mutation = barrier<Response>(); const expired = vi.fn();
  const fetch = vi.fn().mockResolvedValueOnce(response(state)).mockReturnValueOnce(read.promise).mockReturnValueOnce(mutation.promise).mockResolvedValue(response(state)); vi.stubGlobal('fetch', fetch);
  const { result, unmount, rerender } = renderHook(({ active, token }) => useTvPower(active, token, expired), { initialProps: { active: true, token: 'first' } });
  await act(async () => {}); await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); act(() => result.current.start('wake'));
  const readSignal = fetch.mock.calls[1]?.[1].signal as AbortSignal; const writeSignal = fetch.mock.calls[2]?.[1].signal as AbortSignal;
  if (mode === 'unmount') unmount(); else rerender({ active: mode !== 'inactive', token: mode === 'new-session' ? 'second' : 'first' });
  expect(readSignal.aborted).toBe(true); expect(writeSignal.aborted).toBe(true);
  await act(async () => { read.resolve(response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401)); mutation.resolve(response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401)); });
  expect(expired).not.toHaveBeenCalled(); if (mode === 'new-session') expect(result.current.state).toEqual(state);
});

test.each(['read', 'mutation'])('401 from %s stops the runtime and aborts the other request', async (source) => {
  vi.useFakeTimers(); const read = barrier<Response>(); const mutation = barrier<Response>(); const expired = vi.fn();
  const fetch = vi.fn().mockResolvedValueOnce(response(state)).mockReturnValueOnce(read.promise).mockReturnValueOnce(mutation.promise); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useTvPower(true, 'synthetic', expired)); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); act(() => result.current.start('wake'));
  const unauthorized = response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401);
  await act(async () => { (source === 'read' ? read : mutation).resolve(unauthorized); }); expect(expired).toHaveBeenCalledTimes(1);
  expect((fetch.mock.calls[source === 'read' ? 2 : 1]?.[1].signal as AbortSignal).aborted).toBe(true);
  await act(async () => { (source === 'read' ? mutation : read).resolve(response(state)); await vi.advanceTimersByTimeAsync(10000); });
  expect(fetch).toHaveBeenCalledTimes(3); expect(result.current.state).toBeNull();
});

test.each([200, 201])('start API rejects a success status %s that is not acceptance', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(operation, status)));
  expect(api).toHaveProperty('startPower');
  await expect(api.startPower({ id, action: 'wake' }, 'synthetic')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

test('only validated pre-dispatch power rejection proves no send, never status/code alone or malformed errors', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ code: 'OPERATION_CONFLICT', message: 'Synthetic', requestId: 'synthetic' }, 409))
    .mockResolvedValueOnce(response({ code: 'OPERATION_CONFLICT', message: 'Synthetic', requestId: 'synthetic', extra: true }, 409)); vi.stubGlobal('fetch', fetch);
  expect(api).toHaveProperty('startPower');
  const first = await api.startPower({ id, action: 'wake' }, 'synthetic').catch((cause: unknown) => cause);
  expect(first).toHaveProperty('powerRejectedBeforeDispatch', true);
  const second = await api.startPower({ id, action: 'wake' }, 'synthetic').catch((cause: unknown) => cause);
  expect(second).toHaveProperty('powerRejectedBeforeDispatch', false);
  expect(new ApiFailure(409, 'OPERATION_CONFLICT')).toHaveProperty('powerRejectedBeforeDispatch', false);
});

test('failed reads clear stale admission, recover without initial loading, and never POST', async () => {
  vi.useFakeTimers(); const fetch = vi.fn().mockResolvedValueOnce(response(state)).mockRejectedValueOnce(new Error('Synthetic network failure')).mockResolvedValueOnce(response(state));
  vi.stubGlobal('fetch', fetch); const { result } = renderHook(() => useTvPower(true, 'synthetic', vi.fn())); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(result.current.state).toBeNull(); expect(result.current.error).toContain('Нет связи'); expect(result.current.loading).toBe(false);
  act(() => result.current.start('wake')); expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(result.current.state).toEqual(state); expect(result.current.error).toBe(''); expect(result.current.loading).toBe(false);
});

test('an in-flight pre-save read cannot restore the old MAC after a successful clear', async () => {
  vi.useFakeTimers(); const read = barrier<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(response(state)).mockReturnValueOnce(read.promise).mockResolvedValueOnce(response({ ...state, mac: null, canWake: false })); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useTvPower(true, 'synthetic', vi.fn())); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); act(() => result.current.saveMac(null)); await act(async () => {});
  await act(async () => { read.resolve(response(state)); }); expect(result.current.state?.mac).toBeNull(); expect(result.current.state?.canWake).toBe(false);
});

test('cancel validates the returned operation identity', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...operation, id: '00000000-0000-4000-8000-000000000002' })));
  await expect(api.cancelPower(id, 'synthetic')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
