import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App.js';

const csrfToken = 'c'.repeat(43);

afterEach(() => {
  cleanup();
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
    .mockResolvedValueOnce(response(200, { username: 'alice', csrfToken }));
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
});

test('expired session returns to login when an authenticated operation is rejected', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(200, { state: 'claimed' }))
    .mockResolvedValueOnce(response(200, { username: 'alice', csrfToken }))
    .mockResolvedValueOnce(response(401, { code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'request-2' }));
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  expect(await screen.findByText('Телевизор ещё не настроен')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeTruthy();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Сессия истекла. Войдите снова.');
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
  expect(fetch).toHaveBeenCalledTimes(3);
  finish(response(401, { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials', requestId: 'request-3' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Неверное имя или пароль.');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
});
