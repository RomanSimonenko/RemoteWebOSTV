import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Home } from './Home.js';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const saved = { tv: { host: '192.168.1.20', identity: { model: 'Synthetic television' } }, connection: 'unavailable', operation: null };
const device = (tvId = first, status: unknown = saved) => ({ tvId, platform: 'webos', status });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value: function () { this.open = true; } },
  close: { configurable: true, value: function () { this.open = false; } },
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function home(expired = vi.fn()) { return <Home username="synthetic-owner" csrfToken={'c'.repeat(43)} tvActive busy={false} error={null} onLogout={vi.fn()} onSessionExpired={expired} />; }
async function mount(devices: unknown[] = [device()]) {
  const fetch = vi.fn(async (path: string) => response(path === '/api/tvs' ? { devices } : path.endsWith('/power')
    ? { mac: null, canPowerOff: false, canWake: false, operation: null } : path.endsWith('/remote') ? { enabled: false, reason: 'UNAVAILABLE' } : saved));
  vi.stubGlobal('fetch', fetch); render(home()); await act(async () => {}); return fetch;
}
test('opens the exact selected card and returns without mutations', async () => {
  const fetch = await mount([device(), device(second, { ...saved, tv: { ...saved.tv, identity: { model: 'Second TV' } } })]);
  fireEvent.keyDown(document.body, { key: 'ArrowUp' });
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/tvs']);
  fireEvent.click(screen.getByRole('button', { name: 'Открыть телевизор Second TV' })); await act(async () => {});
  expect(screen.getByRole('group', { name: 'Пульт' })).toBeTruthy();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/tvs', `/api/tvs/${second}`, `/api/tvs/${second}/power`, `/api/tvs/${second}/remote`]);
  fireEvent.click(screen.getByRole('button', { name: 'Телевизоры' })); await act(async () => {});
  expect(screen.queryByRole('group', { name: 'Пульт' })).toBeNull();
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/tvs');
});

test('trash requires confirmation, cancellation does not open remote or delete, confirmed deletion removes the card', async () => {
  let deleted = false;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      expect(path).toBe(`/api/tvs/${first}`);
      expect(init.headers).toMatchObject({ 'x-csrf-token': 'c'.repeat(43) });
      expect(JSON.parse(init.body as string)).toEqual({ confirm: true });
      deleted = true; return new Response(null, { status: 204 });
    }
    return response({ devices: deleted ? [] : [device()] });
  });
  vi.stubGlobal('fetch', fetch); render(home()); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Удалить телевизор Synthetic television' }));
  expect(screen.queryByRole('group', { name: 'Пульт' })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  expect(deleted).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Удалить телевизор Synthetic television' }));
  fireEvent.click(screen.getByRole('button', { name: 'Удалить' })); await act(async () => {});
  expect(deleted).toBe(true);
  expect(screen.getByText('Пока нет телевизоров')).toBeTruthy();
});
test.each([[[]], [[device()]]])('adding is available with an empty or populated list', async (devices) => {
  await mount(devices); fireEvent.click(screen.getByRole('button', { name: 'Добавить ТВ' }));
  expect(screen.getByLabelText('IP-адрес телевизора')).toBeTruthy();
});
test.each([['6.5.3', 'webOS 6.5.3'], [undefined, 'webOS']])('card has one action and available OS version %s', async (platformVersion, label) => {
  await mount([device(first, { ...saved, tv: { ...saved.tv, identity: { model: 'Synthetic television', platformVersion, firmwareVersion: '99.8' } } })]);
  const card = screen.getByRole('button', { name: 'Открыть телевизор Synthetic television' });
  expect(within(card).getByText(label)).toBeTruthy();
  expect(card.textContent).not.toContain('99.8');
  expect(within(card.closest('article')!).getByRole('button', { name: 'Удалить телевизор Synthetic television' })).toBeTruthy();
});
test('list failure is not an empty state', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network'))); render(home()); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('Нет связи');
  expect(screen.queryByText('Пока нет телевизоров')).toBeNull();
  expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
});
test('account settings remain separate from TV settings', async () => {
  await mount(); fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
  expect(screen.getByRole('dialog', { name: 'Настройки аккаунта' })).toBeTruthy();
  expect(screen.getByText('Вы вошли как synthetic-owner.')).toBeTruthy();
});
test('adds another TV with CSRF and returns to the refreshed dashboard', async () => {
  let added = false;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/tvs' && init?.method === 'POST') {
      expect(init.headers).toMatchObject({ 'x-csrf-token': 'c'.repeat(43) });
      expect(JSON.parse(init.body as string)).toMatchObject({ platform: 'webos', host: '192.168.1.21' });
      added = true;
      return response({ tvId: second, operation: { id: 'pair', action: 'pair', status: 'running', startedAt: 10000, deadlineAt: 70000 } }, 202);
    }
    if (path === '/api/tvs') return response({ devices: added ? [device(), device(second)] : [device()] });
    if (path === `/api/tvs/${second}`) return response(saved);
    throw new Error('Unexpected route');
  });
  vi.stubGlobal('fetch', fetch); render(home()); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Добавить ТВ' }));
  fireEvent.change(screen.getByLabelText('IP-адрес телевизора'), { target: { value: '192.168.1.21' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Подключить' }).closest('form')!); await act(async () => {});
  expect(screen.getAllByRole('button', { name: /^Открыть телевизор / })).toHaveLength(2);
  expect(fetch.mock.calls.filter(([path]) => path.endsWith('/cancel'))).toHaveLength(0);
});
test('chooseTizenSendsTizen', async () => {
  let submitted: unknown;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      submitted = JSON.parse(init.body as string);
      return response({ tvId: second, operation: { id: 'pair', action: 'pair', status: 'running', startedAt: 10000, deadlineAt: 70000 } }, 202);
    }
    return response(path === '/api/tvs' ? { devices: [] } : { tv: null, connection: 'pairing', operation: null });
  }));
  render(home()); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Добавить ТВ' }));
  fireEvent.change(screen.getByLabelText('Платформа телевизора'), { target: { value: 'tizen' } });
  fireEvent.change(screen.getByLabelText('IP-адрес телевизора'), { target: { value: '192.168.1.21' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Подключить' }).closest('form')!); await act(async () => {});
  expect(submitted).toMatchObject({ platform: 'tizen', host: '192.168.1.21' });
});
test('tizenBadgeDoesNotUseLgLogoOrApiVersion', async () => {
  await mount([{ tvId: second, platform: 'tizen', status: { ...saved, tv: { ...saved.tv, identity: { model: 'Synthetic Samsung', firmwareVersion: '2.0.25' } } } }]);
  const card = screen.getByRole('button', { name: 'Открыть телевизор Synthetic Samsung' });
  expect(within(card).getByText('Tizen')).toBeTruthy();
  expect(within(card).getByText('Samsung')).toBeTruthy();
  expect(within(card).queryByRole('img', { name: 'LG' })).toBeNull();
  expect(card.textContent).not.toContain('2.0.25');
});
test('selected Tizen uses Samsung identity and OS label in shared settings', async () => {
  const status = { ...saved, tv: { ...saved.tv, identity: { model: 'Synthetic Samsung', firmwareVersion: '2.0.25' } } };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => response(path === '/api/tvs' ? { devices: [{ tvId: second, platform: 'tizen', status }] }
    : path.endsWith('/remote') ? { enabled: true, reason: null, apps: false } : path.endsWith('/power') ? { mac: null, canPowerOff: false, canWake: false, operation: null } : status)));
  render(home()); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Открыть телевизор Synthetic Samsung' })); await act(async () => {});
  expect(screen.queryByRole('img', { name: 'LG' })).toBeNull();
  expect(screen.getByText('Samsung')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
  const dialog = screen.getByRole('dialog', { name: 'Настройки телевизора' });
  expect(within(dialog).getByText('Tizen')).toBeTruthy();
  expect(dialog.textContent).not.toContain('2.0.25');
});
test('reload returns to dashboard', async () => {
  await mount(); fireEvent.click(screen.getByRole('button', { name: /^Открыть телевизор / })); await act(async () => {});
  cleanup(); render(home()); await act(async () => {});
  expect(screen.getByRole('heading', { name: 'Телевизоры' })).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'Пульт' })).toBeNull();
});
test('rejected session expires once and stops polling', async () => {
  vi.useFakeTimers(); const expired = vi.fn();
  const fetch = vi.fn().mockResolvedValueOnce(response({ devices: [device()] })).mockResolvedValue(response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401));
  vi.stubGlobal('fetch', fetch); render(home(expired)); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(expired).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
});
