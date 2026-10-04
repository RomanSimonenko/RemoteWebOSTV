import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TvSetup } from './TvSetup.js';
import { Home } from './Home.js';

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) },
    close: { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = false; }) },
  });
});

const csrfToken = 'c'.repeat(43);
const empty = { tv: null, connection: 'unconfigured', operation: null };
const saved = { tv: { host: '192.168.1.20', identity: { model: 'Synthetic TV' } }, connection: 'unavailable', operation: null };
const operation = { id: 'synthetic-operation', action: 'pair', status: 'running', startedAt: 10000, deadlineAt: 70000 };
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function barrier<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function mount() {
  // Capability reads belong to the remote; keep this suite's controlled
  // sequence and assertions scoped to the existing setup/status requests.
  const setupFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (path: RequestInfo | URL, init?: RequestInit) => path === '/api/tv/remote'
    ? Promise.resolve(response({ enabled: false, reason: 'UNSUPPORTED' })) : path === '/api/tv/power'
    ? Promise.resolve(response({ mac: null, canPowerOff: false, canWake: false, operation: null })) : setupFetch(path, init));
  render(<TvSetup csrfToken={csrfToken} settingsOpen onCloseSettings={vi.fn()} onSessionExpired={vi.fn()} />); await act(async () => {});
}
function submitHost(host: string) {
  fireEvent.change(screen.getByLabelText('IP-адрес телевизора'), { target: { value: host } });
  fireEvent.submit(screen.getByLabelText('IP-адрес телевизора').closest('form')!);
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test('keeps refresh enabled during background reads and coalesces clicks without shortening the completion cooldown', async () => {
  vi.useFakeTimers();
  const initial = barrier<Response>();
  const background = barrier<Response>();
  const next = barrier<Response>();
  const fetch = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(background.promise).mockReturnValueOnce(next.promise);
  vi.stubGlobal('fetch', fetch);
  await mount();
  const refresh = screen.getByRole<HTMLButtonElement>('button', { name: 'Обновить статус' });
  expect(refresh.disabled).toBe(true);
  await act(async () => { initial.resolve(response(empty)); });
  expect(refresh.disabled).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(refresh.disabled).toBe(false);
  fireEvent.click(refresh); fireEvent.click(refresh);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(refresh.disabled).toBe(false);
  await act(async () => { background.resolve(response(empty)); });
  fireEvent.click(refresh); fireEvent.click(refresh);
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(refresh.disabled).toBe(false);
  await act(async () => { next.resolve(response(empty)); });
  expect(refresh.disabled).toBe(false);
  expect(screen.getByRole('status', { name: 'Соединение с телевизором' }).textContent).toBe('Введите IP-адрес телевизора');
});

test('validates literal private IPv4 and sends one protected pair request despite double submission', async () => {
  const pending = barrier<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(response(empty)).mockReturnValueOnce(pending.promise);
  vi.stubGlobal('fetch', fetch);
  await mount();
  for (const host of ['', 'localhost', 'http://192.168.1.20', '192.168.1.20:3000', '127.0.0.1', '8.8.8.8', '192.168.01.20']) {
    submitHost(host);
    expect(screen.getByRole('alert').textContent).toContain('IPv4');
    expect(fetch).toHaveBeenCalledTimes(1);
  }
  submitHost(' 192.168.1.20 ');
  submitHost('192.168.1.20');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]).toEqual(['/api/tv/operations', expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: '{"action":"pair","host":"192.168.1.20"}' })]);
  await act(async () => { pending.resolve(response(operation, 202)); });
  expect(screen.getByText('Подтвердите доступ на экране телевизора.')).toBeTruthy();
  expect(screen.getByRole('status', { name: 'Соединение с телевизором' }).textContent).toBe('Сопряжение');
});

test('restores server deadline on reload, keeps an expired operation running until server completion and explicitly cancels', async () => {
  vi.useFakeTimers(); vi.setSystemTime(65000);
  const fetch = vi.fn().mockResolvedValueOnce(response({ ...empty, connection: 'pairing', operation }))
    .mockResolvedValueOnce(response({ ...operation, status: 'cancelled', error: { code: 'CANCELLED', message: 'Операция отменена.' } }));
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(screen.getByText('Осталось: 5 с')).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(72000);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText('Осталось: 0 с')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Отменить' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
  await act(async () => {});
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/tv/operations/synthetic-operation/cancel');
  expect(fetch.mock.calls[1]?.[1].headers).toEqual({ 'x-csrf-token': csrfToken });
  expect(screen.getByRole('alert').textContent).toContain('Операция отменена');
});

test.each([
  ['PAIRING_REJECTED', 'Запрос на сопряжение отклонён.'],
  ['PAIRING_TIMEOUT', 'Время ожидания сопряжения истекло.'],
  ['STORAGE_FAILED', 'Не удалось сохранить настройку телевизора.'],
  ['INVALID_TV_RESPONSE', 'Телевизор вернул некорректный ответ.'],
])('shows safe asynchronous failure %s and an explicit retry', async (code, message) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...empty, operation: { ...operation, status: 'failed', error: { code, message } } })));
  await mount();
  expect(screen.getByRole('alert').textContent).toContain(message);
  expect(screen.getByRole('button', { name: 'Подключить' })).toBeTruthy();
});

test('preserves saved identity and offers reconnect, repair, and change address for the same TV', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(saved)).mockResolvedValue(response({ ...operation, action: 'reconnect' }, 202));
  vi.stubGlobal('fetch', fetch);
  await mount();
  expect(screen.getByText('Synthetic TV')).toBeTruthy();
  expect(screen.getByLabelText('IP-адрес телевизора')).toHaveProperty('value', '192.168.1.20');
  expect(screen.getByText('Нет соединения')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Подключить' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Повторить сопряжение' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Изменить адрес' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Подключиться снова' }));
  await act(async () => {});
  expect(fetch.mock.calls[1]?.[1].body).toBe('{"action":"reconnect"}');
});

test.each([['repair', 'Повторить сопряжение'], ['change_address', 'Изменить адрес']])('submits %s without creating a second TV', async (action, name) => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ ...saved, connection: 'authorization_error' })).mockResolvedValue(response({ ...operation, action }, 202));
  vi.stubGlobal('fetch', fetch);
  await mount();
  if (action === 'change_address') fireEvent.change(screen.getByLabelText('IP-адрес телевизора'), { target: { value: '10.0.0.25' } });
  fireEvent.click(screen.getByRole('button', { name }));
  await act(async () => {});
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual(action === 'repair' ? { action } : { action, host: '10.0.0.25' });
  expect(screen.getByText('Synthetic TV')).toBeTruthy();
});

test.each([[409, 'OPERATION_CONFLICT', 'Другая операция'], [429, 'RATE_LIMITED', 'Слишком много попыток']])('shows actionable HTTP failure %s', async (status, code, message) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(empty)).mockResolvedValueOnce(response({ code, message: 'Synthetic safe error', requestId: 'synthetic' }, status)));
  await mount(); submitHost('10.0.0.25'); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain(message);
});

test('aborts pending mutation on unmount and ignores its late 401', async () => {
  const pending = barrier<Response>(); const expired = vi.fn();
  const fetch = vi.fn().mockResolvedValueOnce(response(empty)).mockReturnValueOnce(pending.promise);
  vi.stubGlobal('fetch', fetch);
  const { unmount } = render(<TvSetup csrfToken={csrfToken} settingsOpen onCloseSettings={vi.fn()} onSessionExpired={expired} />);
  await act(async () => {}); submitHost('10.0.0.25');
  const signal = fetch.mock.calls[1]?.[1].signal as AbortSignal;
  unmount(); expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401)); });
  expect(expired).not.toHaveBeenCalled();
});

test('a new runtime diagnostic takes precedence over a historical operation failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...saved,
    operation: { ...operation, status: 'failed', error: { code: 'PAIRING_TIMEOUT', message: 'Исторический тайм-аут.' } },
    error: { code: 'CONNECTION_LOST', message: 'Соединение с телевизором потеряно.' },
  })));
  await mount();
  expect(screen.getByRole('alert').textContent).toBe('Соединение с телевизором потеряно.');
});

test('completed polling supersedes an accepted operation permanently even if the next read fails', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(response(empty)).mockResolvedValueOnce(response(operation, 202))
    .mockResolvedValueOnce(response({ ...saved, connection: 'available', operation: { ...operation, status: 'succeeded' } }))
    .mockRejectedValueOnce(new Error('synthetic network failure'));
  vi.stubGlobal('fetch', fetch); await mount(); submitHost('192.168.1.20'); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('Подключён')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Отменить' })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole('alert').textContent).toContain('Нет связи');
  expect(screen.getByText('Synthetic TV')).toBeTruthy();
  expect(screen.getByText('Сохранённый IP: 192.168.1.20')).toBeTruthy();
  expect(screen.queryByText('Подключён')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Отменить' })).toBeNull();
});

test('an in-flight status response cannot resurrect a cancelled operation', async () => {
  vi.useFakeTimers();
  const read = barrier<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(response({ ...empty, connection: 'pairing', operation })).mockReturnValueOnce(read.promise)
    .mockResolvedValueOnce(response({ ...operation, status: 'cancelled', error: { code: 'CANCELLED', message: 'Операция отменена.' } }));
  vi.stubGlobal('fetch', fetch); await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  fireEvent.click(screen.getByRole('button', { name: 'Отменить' })); await act(async () => {});
  await act(async () => { read.resolve(response({ ...empty, connection: 'pairing', operation })); });
  expect(screen.queryByRole('button', { name: 'Отменить' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Операция отменена');
});

test.each(['running', 'cancelled'])('a fresh snapshot replaces accepted %s operation A with another tab’s operation B', async (acceptedStatus) => {
  vi.useFakeTimers(); vi.setSystemTime(40000);
  const secondOperation = { ...operation, id: 'a-opaque-new-operation', action: 'repair', startedAt: 5000, deadlineAt: 90000 };
  const fetch = vi.fn().mockResolvedValueOnce(response(acceptedStatus === 'running' ? empty : { ...empty, connection: 'pairing', operation }))
    .mockResolvedValueOnce(response({ ...operation, status: acceptedStatus }))
    .mockResolvedValueOnce(response({ ...saved, connection: 'pairing', operation: secondOperation }))
    .mockResolvedValueOnce(response({ ...secondOperation, status: 'cancelled' }));
  vi.stubGlobal('fetch', fetch); await mount();
  if (acceptedStatus === 'running') submitHost('192.168.1.20');
  else fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
  await act(async () => {});
  // A ends and a second authenticated tab starts B before this tab sees A's terminal snapshot.
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('Осталось: 48 с')).toBeTruthy();
  expect(screen.getByText('Подтвердите доступ на экране телевизора.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Отменить' })); await act(async () => {});
  expect(fetch.mock.calls[3]?.[0]).toBe('/api/tv/operations/a-opaque-new-operation/cancel');
});

test('pairing uses neither browser storage nor logging and strict responses reject secret-bearing payloads', async () => {
  const store = vi.spyOn(Storage.prototype, 'setItem');
  const log = vi.spyOn(console, 'log');
  const warn = vi.spyOn(console, 'warn');
  const error = vi.spyOn(console, 'error');
  const fetch = vi.fn().mockResolvedValueOnce(response(empty)).mockResolvedValueOnce(response({ ...operation, clientKey: 'synthetic-secret' }, 202));
  vi.stubGlobal('fetch', fetch); await mount(); submitHost('10.0.0.25'); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('некорректный ответ');
  expect(screen.queryByText('synthetic-secret')).toBeNull();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/tv', '/api/tv/operations']);
  expect(store).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

test('recovery shares canonical running state, blocks setup and uses the power cancellation route', async () => {
  const power = { id: '00000000-0000-4000-8000-000000000001', action: 'wake', status: 'running', phase: 'connecting', delivery: 'sent', startedAt: 10000, deadlineAt: 70000 };
  const expired = vi.fn();
  const fetch = vi.fn(async (path: RequestInfo | URL) => {
    if (path === '/api/tv') return response({ ...saved, connection: 'connecting', operation: null });
    if (path === '/api/tv/remote') return response({ enabled: false, reason: 'BUSY' });
    if (path === '/api/tv/power') return response({ mac: '02:00:00:00:00:01', canPowerOff: false, canWake: false, operation: power });
    if (path === `/api/tv/power/${power.id}/cancel`) return response({ ...power, status: 'cancelled', phase: 'finished' });
    throw new Error('Unexpected route');
  }); vi.stubGlobal('fetch', fetch); render(<TvSetup csrfToken={csrfToken} settingsOpen onCloseSettings={vi.fn()} onSessionExpired={expired} />); await act(async () => {});
  const reconnect = screen.getByRole<HTMLButtonElement>('button', { name: 'Подключиться снова' });
  expect(reconnect.disabled).toBe(true); fireEvent.click(reconnect);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Изменить адрес' }).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Отменить' })).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Вверх' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Отменить ожидание' })); await act(async () => {});
  expect(fetch.mock.calls.map(([path]) => path).filter((path) => String(path).endsWith('/cancel'))).toEqual([`/api/tv/power/${power.id}/cancel`]);
});

test('closing pending reconnect retains owners and reopening restores saved IP and MAC without initial reads', async () => {
  const pending = barrier<Response>();
  const fetch = vi.fn((path: RequestInfo | URL, init?: RequestInit) => path === '/api/tv' ? Promise.resolve(response(saved))
    : path === '/api/tv/power' ? Promise.resolve(response({ mac: '02:00:00:00:00:01', canPowerOff: false, canWake: true, operation: null }))
    : path === '/api/tv/remote' ? Promise.resolve(response({ enabled: true, reason: null })) : pending.promise);
  vi.stubGlobal('fetch', fetch);
  render(<Home username="alice" csrfToken={csrfToken} tvActive busy={false} error={null} onLogout={vi.fn()} onSessionExpired={vi.fn()} />); await act(async () => {});
  const gear = screen.getByRole('button', { name: 'Настройки' }); gear.focus(); fireEvent.click(gear);
  fireEvent.change(screen.getByRole('textbox', { name: 'IP-адрес телевизора' }), { target: { value: '10.0.0.25' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'MAC-адрес телевизора' }), { target: { value: '02:00:00:00:00:02' } });
  fireEvent.click(screen.getByRole('button', { name: 'Подключиться снова' }));
  const signal = fetch.mock.calls[3]?.[1]?.signal as AbortSignal;
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть настройки' }));
  expect(signal.aborted).toBe(false); expect(document.activeElement).toBe(gear);
  fireEvent.click(gear);
  expect(screen.getByRole('textbox', { name: 'IP-адрес телевизора' })).toHaveProperty('value', '192.168.1.20');
  expect(screen.getByRole('textbox', { name: 'MAC-адрес телевизора' })).toHaveProperty('value', '02:00:00:00:00:01');
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/tv', '/api/tv/power', '/api/tv/remote', '/api/tv/operations']);
  await act(async () => { pending.resolve(response({ ...operation, action: 'reconnect' }, 202)); });
  expect(screen.getByRole('button', { name: 'Отменить' })).toBeTruthy();
});

test('background connection and power diagnostics leave focus in active settings', async () => {
  vi.useFakeTimers(); const tvRead = barrier<Response>(); const powerRead = barrier<Response>();
  let tvReads = 0; let powerReads = 0;
  vi.stubGlobal('fetch', vi.fn((path: RequestInfo | URL) => path === '/api/tv' ? ++tvReads === 1 ? Promise.resolve(response(saved)) : tvRead.promise
    : path === '/api/tv/power' ? ++powerReads === 1 ? Promise.resolve(response({ mac: null, canPowerOff: false, canWake: false, operation: null })) : powerRead.promise
    : Promise.resolve(response({ enabled: true, reason: null }))));
  render(<Home username="alice" csrfToken={csrfToken} tvActive busy={false} error={null} onLogout={vi.fn()} onSessionExpired={vi.fn()} />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Настройки' })); const input = screen.getByRole('textbox', { name: 'IP-адрес телевизора' }); input.focus();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  await act(async () => { tvRead.resolve(response({ ...saved, error: { code: 'CONNECTION_LOST', message: 'Синтетическая потеря соединения.' } })); powerRead.resolve(response({ code: 'STORAGE_FAILED', message: 'Synthetic', requestId: 'synthetic' }, 503)); });
  expect(document.activeElement).toBe(input);
  expect(screen.getByRole('dialog', { name: 'Настройки телевизора' }).contains(screen.getByText('Синтетическая потеря соединения.'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть настройки' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Настройки' }));
});

test('losing power-off eligibility dismisses confirmation and unlocks settings', async () => {
  vi.useFakeTimers(); let powerReads = 0;
  vi.stubGlobal('fetch', vi.fn((path: RequestInfo | URL) => Promise.resolve(response(path === '/api/tv' ? saved : path === '/api/tv/power'
    ? { mac: '02:00:00:00:00:01', canPowerOff: ++powerReads === 1, canWake: false, operation: null } : { enabled: true, reason: null }))));
  render(<Home username="alice" csrfToken={csrfToken} tvActive busy={false} error={null} onLogout={vi.fn()} onSessionExpired={vi.fn()} />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Выключить ТВ' })); expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Настройки' }).disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.queryByRole('dialog', { name: 'Выключить телевизор?' })).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Настройки' }).disabled).toBe(false);
});

test('MAC save keeps its protected request alive on close and reopening shows the new saved value', async () => {
  const pending = barrier<Response>();
  const fetch = vi.fn((path: RequestInfo | URL, init?: RequestInit) => init?.method === 'PUT' ? pending.promise : Promise.resolve(response(path === '/api/tv' ? saved : path === '/api/tv/power'
    ? { mac: '02:00:00:00:00:01', canPowerOff: false, canWake: true, operation: null } : { enabled: true, reason: null })));
  vi.stubGlobal('fetch', fetch);
  render(<Home username="alice" csrfToken={csrfToken} tvActive busy={false} error={null} onLogout={vi.fn()} onSessionExpired={vi.fn()} />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'MAC-адрес телевизора' }), { target: { value: '02:00:00:00:00:02' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить MAC' }));
  expect(fetch.mock.calls[3]).toEqual(['/api/tv/mac', expect.objectContaining({ method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: '{"mac":"02:00:00:00:00:02"}' })]);
  const signal = fetch.mock.calls[3]?.[1]?.signal as AbortSignal;
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть настройки' })); expect(signal.aborted).toBe(false);
  await act(async () => { pending.resolve(response({ mac: '02:00:00:00:00:02', canPowerOff: false, canWake: true, operation: null })); });
  fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
  expect(screen.getByRole('textbox', { name: 'MAC-адрес телевизора' })).toHaveProperty('value', '02:00:00:00:00:02');
  expect(fetch).toHaveBeenCalledTimes(4);
});

test('power confirmation disables settings until dismissed and settings disable power activation', async () => {
  const fetch = vi.fn((path: RequestInfo | URL) => Promise.resolve(response(path === '/api/tv' ? saved : path === '/api/tv/power'
    ? { mac: '02:00:00:00:00:01', canPowerOff: true, canWake: false, operation: null } : { enabled: true, reason: null })));
  vi.stubGlobal('fetch', fetch);
  render(<Home username="alice" csrfToken={csrfToken} tvActive busy={false} error={null} onLogout={vi.fn()} onSessionExpired={vi.fn()} />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Выключить ТВ' }));
  const gear = screen.getByRole<HTMLButtonElement>('button', { name: 'Настройки' }); expect(gear.disabled).toBe(true); fireEvent.click(gear);
  expect(screen.queryByRole('dialog', { name: 'Настройки телевизора' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Не выключать' })); expect(gear.disabled).toBe(false); fireEvent.click(gear);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Выключить ТВ' }).disabled).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test('server-owned automatic recovery disables setup and offers no unauthorized cancellation', async () => {
  const power = { id: '00000000-0000-4000-8000-000000000001', action: 'recover', status: 'running', phase: 'connecting', delivery: 'not_sent', startedAt: 10000, deadlineAt: 70000 };
  const fetch = vi.fn(async (path: RequestInfo | URL) => path === '/api/tv' ? response({ ...saved, connection: 'connecting', operation: null })
    : path === '/api/tv/power' ? response({ mac: null, canPowerOff: false, canWake: false, operation: power })
    : response({ enabled: false, reason: 'BUSY' })); vi.stubGlobal('fetch', fetch);
  render(<TvSetup csrfToken={csrfToken} settingsOpen onCloseSettings={vi.fn()} onSessionExpired={vi.fn()} />); await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Отменить ожидание' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Отменить' })).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Подключиться снова' }).disabled).toBe(true);
  submitHost('10.0.0.25'); await act(async () => {}); expect(fetch).toHaveBeenCalledTimes(3);
});

test('manual reconnect keeps its legacy cancel path alongside a previous completed power operation', async () => {
  const power = { id: '00000000-0000-4000-8000-000000000001', action: 'recover', status: 'failed', phase: 'finished', delivery: 'not_sent', startedAt: 10000, deadlineAt: 70000, error: { code: 'RECOVERY_TIMEOUT', message: 'Synthetic diagnostic' } };
  const fetch = vi.fn(async (path: RequestInfo | URL) => {
    if (path === '/api/tv') return response({ ...saved, connection: 'connecting', operation: { ...operation, action: 'reconnect' } });
    if (path === '/api/tv/power') return response({ mac: null, canPowerOff: false, canWake: false, operation: power });
    if (path === '/api/tv/remote') return response({ enabled: false, reason: 'BUSY' });
    return response({ ...operation, action: 'reconnect', status: 'cancelled' });
  }); vi.stubGlobal('fetch', fetch); render(<TvSetup csrfToken={csrfToken} settingsOpen onCloseSettings={vi.fn()} onSessionExpired={vi.fn()} />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Отменить' })); await act(async () => {});
  expect(fetch.mock.calls.map(([path]) => path).filter((path) => String(path).endsWith('/cancel'))).toEqual(['/api/tv/operations/synthetic-operation/cancel']);
});
