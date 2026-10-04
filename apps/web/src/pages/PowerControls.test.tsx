import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PowerControls } from './PowerControls.js';

const csrfToken = 'c'.repeat(43);
const id = '00000000-0000-4000-8000-000000000001';
const off = { mac: null, canPowerOff: true, canWake: false, operation: null };
const wake = { mac: '02:00:00:00:00:01', canPowerOff: false, canWake: true, operation: null };
const operation = { id, action: 'wake', status: 'running', phase: 'sending', delivery: 'not_sent', startedAt: 10000, deadlineAt: 70000 };
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function barrier<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function mount() { render(<PowerControls csrfToken={csrfToken} active onSessionExpired={vi.fn()} />); await act(async () => {}); }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('cancelling explicit power-off confirmation sends no mutation', async () => {
  const fetch = vi.fn().mockResolvedValue(response(off)); vi.stubGlobal('fetch', fetch); await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Выключить ТВ' }));
  expect(screen.getByRole('dialog', { name: 'Выключить телевизор?' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Не выключать' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
});

test('two rapid confirmations dispatch exactly one protected operation with an HTTP-LAN UUID', async () => {
  const pending = barrier<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(response(off)).mockReturnValueOnce(pending.promise); vi.stubGlobal('fetch', fetch);
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('Unavailable on HTTP'); }); await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Выключить ТВ' }));
  const confirm = screen.getByRole('button', { name: 'Подтвердить выключение' }); fireEvent.click(confirm); fireEvent.click(confirm);
  expect(fetch).toHaveBeenCalledTimes(2);
  const [url, init] = fetch.mock.calls[1]!;
  expect(url).toBe('/api/tv/power'); expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken } });
  const input = JSON.parse(init.body); expect(input).toEqual({ id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), action: 'power_off', confirm: true });
  await act(async () => { pending.resolve(response({ ...operation, id: input.id, action: 'power_off' }, 202)); });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Выключить ТВ' }).disabled).toBe(true);
});

test('wake requires configured MAC, saves a normalized MAC and clears it explicitly', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ ...off, canPowerOff: false }))
    .mockResolvedValueOnce(response(wake)).mockResolvedValueOnce(response({ ...off, canPowerOff: false })); vi.stubGlobal('fetch', fetch); await mount();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Включить ТВ' }).disabled).toBe(true);
  const input = screen.getByLabelText('MAC-адрес телевизора');
  fireEvent.change(input, { target: { value: '01:00:00:00:00:01' } }); fireEvent.submit(input.closest('form')!);
  expect(screen.getByRole('alert').textContent).toContain('MAC'); expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: '02-00-00-00-00-01' } }); fireEvent.submit(input.closest('form')!); await act(async () => {});
  expect(fetch.mock.calls[1]).toEqual(['/api/tv/mac', expect.objectContaining({ method: 'PUT', body: '{"mac":"02:00:00:00:00:01"}', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken } })]);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Включить ТВ' }).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Очистить MAC' })); await act(async () => {});
  expect(fetch.mock.calls[2]?.[1].body).toBe('{"mac":null}'); expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Включить ТВ' }).disabled).toBe(true);
});

test.each([
  ['not_sent', 'Отправляем сигнал включения'],
  ['unknown', 'Результат отправки неизвестен'],
  ['sent', 'Сигнал включения отправлен. Ожидаем телевизор'],
])('running wake delivery %s does not claim Connected', async (delivery, text) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...wake, canWake: false, operation: { ...operation, delivery } }))); await mount();
  expect(screen.getByRole('status', { name: 'Питание телевизора' }).textContent).toContain(text);
  expect(screen.queryByText('Подключён')).toBeNull();
});

test.each([
  ['RECOVERY_TIMEOUT', 'Не удалось подключиться к телевизору'],
  ['AUTHORIZATION_FAILED', 'Повторите сопряжение'],
  ['UNSUPPORTED_CAPABILITY', 'не поддерживает'],
  ['POWER_OFF_UNCONFIRMED', 'Выключение не подтверждено'],
])('terminal %s offers a distinct safe diagnostic', async (code, text) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...wake, operation: { ...operation, action: code === 'POWER_OFF_UNCONFIRMED' ? 'power_off' : 'wake', status: 'failed', phase: 'finished', delivery: 'sent', error: { code, message: 'Synthetic safe diagnostic' } } }))); await mount();
  expect(screen.getByRole('alert').textContent).toContain(text); expect(screen.queryByRole('button', { name: 'Отменить ожидание' })).toBeNull();
});

test('reload restores deadline and cancellation without starting or replaying wake', async () => {
  vi.useFakeTimers(); vi.setSystemTime(65000);
  const fetch = vi.fn().mockResolvedValueOnce(response({ ...wake, canWake: false, operation }))
    .mockResolvedValueOnce(response({ ...operation, status: 'cancelled', phase: 'finished', error: { code: 'CANCELLED', message: 'Операция отменена.' } })); vi.stubGlobal('fetch', fetch); await mount();
  expect(screen.getByText('Осталось: 5 с')).toBeTruthy(); expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Отменить ожидание' })); await act(async () => {});
  expect(fetch.mock.calls[1]?.[0]).toBe(`/api/tv/power/${id}/cancel`); expect(screen.getByRole('alert').textContent).toContain('Операция отменена');
});

test.each(['network', 'malformed', 'wrong-id', 'wrong-action'])('an uncertain %s start does not replay POST and refreshes state', async (failure) => {
  vi.useFakeTimers(); const fetch = vi.fn().mockResolvedValueOnce(response(wake));
  fetch.mockImplementationOnce(async (_path, init) => {
    if (failure === 'network') throw new Error('Synthetic loss');
    const input = JSON.parse(init.body);
    return response(failure === 'malformed' ? { ...operation, extra: true } : { ...operation, id: failure === 'wrong-id' ? id : input.id, action: failure === 'wrong-action' ? 'power_off' : 'wake' }, 202);
  }).mockImplementation(async () => response({ ...wake, canWake: false, operation: { ...operation, delivery: 'sent', phase: 'connecting' } })); vi.stubGlobal('fetch', fetch); await mount();
  const button = screen.getByRole('button', { name: 'Включить ТВ' }); fireEvent.click(button); fireEvent.click(button); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('Результат операции неизвестен');
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(screen.getByRole('status', { name: 'Питание телевизора' }).textContent).toContain('Сигнал включения отправлен');
});

test('an accepted deadline reaching zero waits for server completion and never starts another operation', async () => {
  vi.useFakeTimers(); vi.setSystemTime(69000); const pending = barrier<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(response({ ...wake, canWake: false, operation })).mockReturnValueOnce(pending.promise); vi.stubGlobal('fetch', fetch); await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); expect(screen.getByText('Осталось: 0 с')).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Включить ТВ' }).disabled).toBe(true);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});

test('power-off acknowledgment with unavailable connection never claims physical power-off', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...off, canPowerOff: false, operation: { ...operation, action: 'power_off', status: 'succeeded', phase: 'finished', delivery: 'sent' } }))); await mount();
  expect(screen.getByRole('status', { name: 'Питание телевизора' }).textContent).toContain('фактическое выключение не подтверждено');
});

test('UUID preparation failure sends no mutation and is reported as not sent', async () => {
  const fetch = vi.fn().mockResolvedValue(response(wake)); vi.stubGlobal('fetch', fetch); await mount();
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw new Error('Synthetic failure'); });
  fireEvent.click(screen.getByRole('button', { name: 'Включить ТВ' })); expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alert').textContent).toContain('Операция не отправлена');
});

test('validated rejection remains actionable, while receipt capacity asks for a new login', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(wake)).mockResolvedValueOnce(response({ code: 'POWER_RECEIPT_CAPACITY', message: 'Synthetic error', requestId: 'synthetic' }, 409)); vi.stubGlobal('fetch', fetch); await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Включить ТВ' })); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('Войдите заново'); expect(screen.getByRole('alert').textContent).not.toContain('Результат операции неизвестен');
});

test('MAC and power responses never enter browser storage or logs', async () => {
  const store = vi.spyOn(Storage.prototype, 'setItem'); const log = vi.spyOn(console, 'log'); const warn = vi.spyOn(console, 'warn'); const error = vi.spyOn(console, 'error');
  const fetch = vi.fn().mockResolvedValueOnce(response(wake)).mockImplementationOnce(async (_path, init) => response({ ...operation, id: JSON.parse(init.body).id, clientKey: 'synthetic-secret' }, 202)); vi.stubGlobal('fetch', fetch); await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Включить ТВ' })); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('Результат операции неизвестен'); expect(screen.queryByText('synthetic-secret')).toBeNull();
  expect(store).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
