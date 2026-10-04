import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App.js';

const csrfToken = 'c'.repeat(43);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function response(status: number, data?: unknown) {
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
  });
}

test('unclaimed installation shows setup and moves to login after claim', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(200, { state: 'unclaimed' }))
    .mockResolvedValueOnce(response(201));
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Первичная настройка' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Установочный токен'), { target: { value: 't'.repeat(43) } });
  fireEvent.change(screen.getByLabelText('Имя владельца'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'correct horse battery staple' } });
  expect(screen.getByLabelText('Пароль').getAttribute('autocomplete')).toBe('new-password');
  fireEvent.submit(screen.getByRole('button', { name: 'Создать владельца' }).closest('form')!);
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeTruthy();
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/setup');
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ token: 't'.repeat(43), username: 'alice', password: 'correct horse battery staple' }));
});

test('claimed installation shows login, then authenticated home after verified session', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(200, { state: 'claimed' }))
    .mockResolvedValueOnce(response(401, { code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'request-1' }))
    .mockResolvedValueOnce(response(200, { username: 'alice' }))
    .mockResolvedValueOnce(response(200, { username: 'alice', csrfToken }))
    .mockResolvedValueOnce(response(200, { tv: null, connection: 'unconfigured', operation: null }));
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Имя владельца'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'correct horse battery staple' } });
  expect(screen.getByLabelText('Пароль').getAttribute('autocomplete')).toBe('current-password');
  fireEvent.submit(screen.getByRole('button', { name: 'Войти' }).closest('form')!);
  expect(await screen.findByText('Телевизор ещё не настроен')).toBeTruthy();
  expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  expect(fetch.mock.calls[3]?.[0]).toBe('/api/auth/session');
  expect(await screen.findByLabelText('IP-адрес телевизора')).toBeTruthy();
});

test('expired session returns to login when an authenticated operation is rejected', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(200, { state: 'claimed' }))
    .mockResolvedValueOnce(response(200, { username: 'alice', csrfToken }))
    .mockResolvedValueOnce(response(200, { tv: null, connection: 'unconfigured', operation: null }))
    .mockResolvedValueOnce(response(401, { code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'request-2' }));
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  expect(await screen.findByText('Телевизор ещё не настроен')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeTruthy();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Сессия истекла. Войдите снова.');
});

test('authenticated reload reads TV status without starting a new pairing', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(200, { state: 'claimed' }))
    .mockResolvedValueOnce(response(200, { username: 'alice', csrfToken }))
    .mockResolvedValueOnce(response(200, { tv: { host: '192.168.1.20', identity: { model: 'Synthetic TV' } }, connection: 'unavailable', operation: null }))
    .mockResolvedValueOnce(response(200, { mac: null, canPowerOff: false, canWake: false, operation: null }))
    .mockResolvedValueOnce(response(200, { enabled: false, reason: 'UNAVAILABLE' }));
  vi.stubGlobal('fetch', fetch); render(<App />);
  expect(await screen.findByText('Synthetic TV')).toBeTruthy();
  expect(screen.getByText('192.168.1.20')).toBeTruthy();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/setup/status', '/api/auth/session', '/api/tv', '/api/tv/power', '/api/tv/remote']);
});

test('status 401 returns to login through the App session owner', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(200, { state: 'claimed' }))
    .mockResolvedValueOnce(response(200, { username: 'alice', csrfToken }))
    .mockResolvedValueOnce(response(401, { code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }));
  vi.stubGlobal('fetch', fetch); render(<App />);
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Сессия истекла');
  expect(screen.queryByLabelText('IP-адрес телевизора')).toBeNull();
});

test('logout during pair stops UI requests immediately and ignores late responses without cancelling server work', async () => {
  let finishStatus!: (value: Response) => void;
  let finishLogout!: (value: Response) => void;
  const pendingStatus = new Promise<Response>((resolve) => { finishStatus = resolve; });
  const pendingLogout = new Promise<Response>((resolve) => { finishLogout = resolve; });
  const fetch = vi.fn().mockResolvedValueOnce(response(200, { state: 'claimed' }))
    .mockResolvedValueOnce(response(200, { username: 'alice', csrfToken }))
    .mockReturnValueOnce(pendingStatus).mockReturnValueOnce(pendingLogout);
  vi.stubGlobal('fetch', fetch); render(<App />);
  await screen.findByRole('button', { name: 'Выйти' });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  const signal = fetch.mock.calls[2]?.[1].signal as AbortSignal;
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
  expect(signal.aborted).toBe(true);
  finishStatus(response(200, { tv: { host: '192.168.1.20', identity: { model: 'Late synthetic TV' } }, connection: 'available', operation: null }));
  finishLogout(response(204));
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeTruthy();
  expect(screen.queryByText('Late synthetic TV')).toBeNull();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/setup/status', '/api/auth/session', '/api/tv', '/api/auth/logout']);
});

test('logout stays available while a pair submission is pending and aborts it without an explicit server cancellation', async () => {
  vi.useFakeTimers();
  let finishPair!: (value: Response) => void;
  const pair = new Promise<Response>((resolve) => { finishPair = resolve; });
  const fetch = vi.fn().mockResolvedValueOnce(response(200, { state: 'claimed' }))
    .mockResolvedValueOnce(response(200, { username: 'alice', csrfToken }))
    .mockResolvedValueOnce(response(200, { tv: null, connection: 'unconfigured', operation: null }))
    .mockReturnValueOnce(pair).mockResolvedValueOnce(response(204));
  vi.stubGlobal('fetch', fetch); render(<App />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText('IP-адрес телевизора'), { target: { value: '10.0.0.25' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Подключить' }).closest('form')!);
  const signal = fetch.mock.calls[3]?.[1].signal as AbortSignal;
  expect((screen.getByRole('button', { name: 'Выйти' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finishPair(response(202, { id: 'late-synthetic', action: 'pair', status: 'running', startedAt: 10000, deadlineAt: 70000 }));
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(screen.getByRole('heading', { name: 'Вход' })).toBeTruthy();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/setup/status', '/api/auth/session', '/api/tv', '/api/tv/operations', '/api/auth/logout']);
});

test('pending login cannot submit twice and reports a safe server error', async () => {
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  const fetch = vi.fn().mockResolvedValueOnce(response(200, { state: 'claimed' }))
    .mockResolvedValueOnce(response(401, { code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'request-1' }))
    .mockReturnValueOnce(pending);
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByRole('heading', { name: 'Вход' });
  fireEvent.change(screen.getByLabelText('Имя владельца'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'correct horse battery staple' } });
  const button = screen.getByRole('button', { name: 'Войти' }) as HTMLButtonElement;
  fireEvent.submit(button.closest('form')!);
  fireEvent.submit(button.closest('form')!);
  await waitFor(() => expect(button.disabled).toBe(true));
  expect(screen.getByRole('status').textContent).toBe('Выполняется вход…');
  expect(fetch).toHaveBeenCalledTimes(3);
  finish(response(401, { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials', requestId: 'request-3' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Неверное имя или пароль.');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
});

test('pending setup announces progress in a live status region', async () => {
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  const fetch = vi.fn().mockResolvedValueOnce(response(200, { state: 'unclaimed' }))
    .mockReturnValueOnce(pending);
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByRole('heading', { name: 'Первичная настройка' });
  fireEvent.change(screen.getByLabelText('Установочный токен'), { target: { value: 't'.repeat(43) } });
  fireEvent.change(screen.getByLabelText('Имя владельца'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'correct horse battery staple' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Создать владельца' }).closest('form')!);
  expect((await screen.findByRole('status')).textContent).toBe('Создаём владельца…');
  finish(response(201));
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeTruthy();
});

test('setup validates Unicode code points and submits the full supplementary-character username', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(200, { state: 'unclaimed' }))
    .mockResolvedValueOnce(response(201));
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByRole('heading', { name: 'Первичная настройка' });
  fireEvent.change(screen.getByLabelText('Установочный токен'), { target: { value: 't'.repeat(43) } });
  const username = screen.getByLabelText('Имя владельца') as HTMLInputElement;
  const password = screen.getByLabelText('Пароль') as HTMLInputElement;
  const form = screen.getByRole('button', { name: 'Создать владельца' }).closest('form')!;
  // Native limits count UTF-16 units and would prevent entering the accepted username.
  expect.soft(username.hasAttribute('maxlength')).toBe(false);
  expect.soft(password.hasAttribute('minlength')).toBe(false);
  expect.soft(password.hasAttribute('maxlength')).toBe(false);
  fireEvent.change(username, { target: { value: '😀'.repeat(64) } });
  fireEvent.change(password, { target: { value: '😀'.repeat(6) } });
  fireEvent.submit(form);
  expect.soft(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alert').textContent).toContain('12');
  fireEvent.change(password, { target: { value: '😀'.repeat(12) } });
  fireEvent.submit(form);
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeTruthy();
  expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body)).toEqual({ token: 't'.repeat(43), username: '😀'.repeat(64), password: '😀'.repeat(12) });
});
