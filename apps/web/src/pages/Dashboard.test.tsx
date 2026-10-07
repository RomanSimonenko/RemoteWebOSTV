import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Home } from './Home.js';

const empty = { tv: null, connection: 'unconfigured', operation: null };
const saved = { tv: { host: '192.168.1.20', identity: { model: 'Synthetic television' } }, connection: 'unavailable', operation: null };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value: function () { this.open = true; } },
  close: { configurable: true, value: function () { this.open = false; } },
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(data: unknown = saved) {
  const fetch = vi.fn(async (path: string) => response(path === '/api/tv' ? data : path === '/api/tv/power'
    ? { mac: null, canPowerOff: false, canWake: false, operation: null } : { enabled: false, reason: 'UNAVAILABLE' }));
  vi.stubGlobal('fetch', fetch);
  render(<Home username="synthetic-owner" csrfToken={'c'.repeat(43)} tvActive busy={false} error={null} onLogout={vi.fn()} onSessionExpired={vi.fn()} />);
  await act(async () => {});
  return fetch;
}
test('saved offline television opens from dashboard and back sends no mutations', async () => {
  const fetch = await mount();
  expect(screen.getByRole('heading', { name: 'Телевизоры' })).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'Пульт' })).toBeNull();
  expect(screen.queryByText('192.168.1.20')).toBeNull();
  fireEvent.keyDown(document.body, { key: 'ArrowUp' });
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/tv']);
  fireEvent.click(screen.getByRole('button', { name: /^Открыть телевизор / })); await act(async () => {});
  expect(screen.getByRole('group', { name: 'Пульт' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Телевизоры' }));
  expect(screen.queryByRole('group', { name: 'Пульт' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Телевизоры' })).toBeTruthy();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/tv', '/api/tv/power', '/api/tv/remote']);
});
test('empty dashboard opens pairing only on add', async () => {
  await mount(empty);
  expect(screen.getByRole('heading', { name: 'Пока нет телевизоров' })).toBeTruthy();
  expect(screen.queryByLabelText('IP-адрес телевизора')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Добавить ТВ' }));
  expect(screen.getByLabelText('IP-адрес телевизора')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Телевизоры' }));
  expect(screen.getByRole('button', { name: 'Добавить ТВ' })).toBeTruthy();
});
test.each([['6.5.3', 'webOS 6.5.3'], [undefined, 'webOS']])('device card has one action and shows available OS version %s', async (platformVersion, label) => {
  await mount({ ...saved, tv: { ...saved.tv, identity: { model: 'Synthetic television', platformVersion, firmwareVersion: '99.8' } } });
  const card = screen.getByRole('button', { name: 'Открыть телевизор Synthetic television' });
  expect(within(card).getByText(label)).toBeTruthy();
  expect(card.textContent).not.toContain('99.8');
  expect(screen.queryByRole('button', { name: 'Открыть пульт' })).toBeNull();
  expect(card.closest('article')!.querySelectorAll('button')).toHaveLength(1);
  fireEvent.click(card); await act(async () => {});
  expect(screen.getByRole('group', { name: 'Пульт' })).toBeTruthy();
});
test('failed API read is not mistaken for an empty dashboard', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic network')));
  render(<Home username="synthetic-owner" csrfToken={'c'.repeat(43)} tvActive busy={false} error={null} onLogout={vi.fn()} onSessionExpired={vi.fn()} />);
  await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('Нет связи');
  expect(screen.queryByRole('button', { name: 'Добавить ТВ' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
});
test('dashboard settings expose account only', async () => {
  await mount(); fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
  expect(screen.getByRole('dialog', { name: 'Настройки аккаунта' })).toBeTruthy();
  expect(screen.getByText('Вы вошли как synthetic-owner.')).toBeTruthy();
  expect(screen.queryByLabelText('IP-адрес телевизора')).toBeNull();
});
test('pairing uses the existing protected API and returns to a real device card', async () => {
  vi.useFakeTimers();
  let configured = false;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/tv') return response(configured ? saved : empty);
    if (path === '/api/tv/operations') {
      expect(init?.headers).toMatchObject({ 'x-csrf-token': 'c'.repeat(43) });
      expect(JSON.parse(init!.body as string)).toEqual({ action: 'pair', host: '192.168.1.20' });
      configured = true;
      return response({ id: 'synthetic-pair', action: 'pair', status: 'running', startedAt: 10000, deadlineAt: 70000 }, 202);
    }
    throw new Error('Unexpected synthetic route');
  });
  vi.stubGlobal('fetch', fetch);
  render(<Home username="synthetic-owner" csrfToken={'c'.repeat(43)} tvActive busy={false} error={null} onLogout={vi.fn()} onSessionExpired={vi.fn()} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Добавить ТВ' }));
  fireEvent.change(screen.getByLabelText('IP-адрес телевизора'), { target: { value: '192.168.1.20' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Подключить' }).closest('form')!);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Телевизоры' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole('button', { name: /^Открыть телевизор / })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Добавить ТВ' })).toBeNull();
  expect(fetch.mock.calls.filter(([path]) => path.endsWith('/cancel'))).toHaveLength(0);
  expect(fetch.mock.calls.filter(([path]) => path === '/api/tv')).toHaveLength(2);
});
test('dashboard polling expires a rejected session once and stops reading', async () => {
  vi.useFakeTimers(); const expired = vi.fn();
  const fetch = vi.fn().mockResolvedValueOnce(response(saved)).mockResolvedValue(response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401));
  vi.stubGlobal('fetch', fetch);
  render(<Home username="synthetic-owner" csrfToken={'c'.repeat(43)} tvActive busy={false} error={null} onLogout={vi.fn()} onSessionExpired={expired} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(expired).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});
