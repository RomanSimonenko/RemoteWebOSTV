import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Home } from './Home.js';
import { Remote } from './Remote.js';
import { App } from '../App.js';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
test('saved television exposes the browser remote beside its setup', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path === '/api/tv'
    ? { tv: { host: '192.168.1.20', identity: { model: 'Synthetic TV' } }, connection: 'available', operation: null }
    : { enabled: true, reason: null }), { status: 200 })));
  render(<Home username="alice" csrfToken={'c'.repeat(43)} tvActive busy={false} error={null} onLogout={vi.fn()} onSessionExpired={vi.fn()} />);
  await act(async () => {});
  expect(screen.getByRole('group', { name: 'Пульт' })).toBeTruthy();
});

const csrfToken = 'c'.repeat(43);
const saved = { tv: { host: '192.168.1.20', identity: { model: 'Synthetic TV' } }, connection: 'available', operation: null };
const ready = { enabled: true, reason: null };
const unknown = 'Результат команды неизвестен. Автоматический повтор не выполняется';
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function barrier<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function home(active = true, expired = vi.fn()) {
  return <Home username="alice" csrfToken={csrfToken} tvActive={active} busy={false} error={null} onLogout={vi.fn()} onSessionExpired={expired} />;
}
async function mount(command = (input: { id: string; button: string }) => Promise.resolve(response({ id: input.id, outcome: 'sent' })), state = () => Promise.resolve(response(ready)), expired = vi.fn()) {
  const fetch = vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/tv') return Promise.resolve(response(saved));
    if (path === '/api/tv/remote') return state();
    if (path === '/api/tv/commands') return command(JSON.parse(init!.body as string));
    throw new Error('Unexpected test route');
  });
  vi.stubGlobal('fetch', fetch);
  const view = render(home(true, expired));
  await act(async () => {});
  return { ...view, fetch, commands: () => fetch.mock.calls.filter(([path]) => path === '/api/tv/commands'), reads: () => fetch.mock.calls.filter(([path]) => path === '/api/tv/remote') };
}
const buttons = [['Вверх', 'UP'], ['Вниз', 'DOWN'], ['Влево', 'LEFT'], ['Вправо', 'RIGHT'], ['OK', 'ENTER'], ['Назад', 'BACK'], ['Домой', 'HOME'], ['Громкость +', 'VOLUME_UP'], ['Громкость −', 'VOLUME_DOWN'], ['Без звука', 'MUTE']];
test.each(buttons)('click %s sends one protected correlated %s command', async (label, button) => {
  const view = await mount();
  fireEvent.click(screen.getByRole('button', { name: label })); await act(async () => {});
  expect(view.commands()).toHaveLength(1);
  const init = view.commands()[0]![1]!;
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken } });
  expect(JSON.parse(init.body as string)).toEqual({ id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i), button });
  expect(within(screen.getByRole('group', { name: 'Пульт' })).getByRole('status').textContent).toBe('Команда отправлена');
});
test('pending disables every command and ignores a second activation', async () => {
  const pending = barrier<Response>(); const view = await mount(() => pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); fireEvent.click(screen.getByRole('button', { name: 'Вверх' }));
  expect(view.commands()).toHaveLength(1);
  for (const button of within(screen.getByRole('group', { name: 'Пульт' })).getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { pending.resolve(response({ id: JSON.parse(view.commands()[0]![1]!.body as string).id, outcome: 'sent' })); });
  expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(false);
});
test.each([['ArrowUp', 'UP'], ['ArrowDown', 'DOWN'], ['ArrowLeft', 'LEFT'], ['ArrowRight', 'RIGHT'], ['Enter', 'ENTER'], ['Escape', 'BACK'], ['Home', 'HOME'], ['+', 'VOLUME_UP'], ['-', 'VOLUME_DOWN'], ['m', 'MUTE'], ['M', 'MUTE']])('focused keyboard %s maps to %s once', async (key, button) => {
  const view = await mount(); const group = screen.getByRole('group', { name: 'Пульт' }); group.focus();
  fireEvent.keyDown(group, { key }); await act(async () => {});
  expect(view.commands()).toHaveLength(1); expect(JSON.parse(view.commands()[0]![1]!.body as string).button).toBe(button);
});
test('Enter on a command button belongs to the remote mapping, suppressing native duplicate activation', async () => {
  const view = await mount(); const button = screen.getByRole('button', { name: 'Вверх' }); button.focus();
  // A browser only synthesizes a click when keydown was not cancelled.
  const defaultAllowed = fireEvent.keyDown(button, { key: 'Enter' });
  if (defaultAllowed) fireEvent.click(button);
  await act(async () => {});
  expect(view.commands()).toHaveLength(1); expect(JSON.parse(view.commands()[0]![1]!.body as string).button).toBe('ENTER');
});
test('repeat, modifiers, editable targets, outside focus and hidden document never send keyboard commands', async () => {
  const view = await mount(); const group = screen.getByRole('group', { name: 'Пульт' }); group.focus();
  for (const flags of [{ repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) expect(fireEvent.keyDown(group, { key: 'ArrowUp', ...flags })).toBe(true);
  for (const tag of ['input', 'textarea', 'select']) { const input = document.createElement(tag); group.append(input); input.focus(); fireEvent.keyDown(input, { key: 'ArrowUp' }); input.remove(); }
  const editable = document.createElement('div'); editable.setAttribute('contenteditable', 'true'); editable.tabIndex = 0; group.append(editable); editable.focus(); fireEvent.keyDown(editable, { key: 'Enter' }); editable.remove();
  screen.getByLabelText('IP-адрес телевизора').focus(); fireEvent.keyDown(group, { key: 'ArrowUp' }); fireEvent.keyDown(document.body, { key: 'ArrowUp' });
  group.focus(); const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); fireEvent.keyDown(group, { key: 'ArrowUp' }); visibility.mockRestore();
  expect(view.commands()).toHaveLength(0);
});
test.each([['UNAVAILABLE', 'Телевизор недоступен'], ['BUSY', 'Телевизор занят'], ['UNSUPPORTED', 'Управление кнопками не поддерживается']])('capability reason %s disables controls with safe explanation', async (reason, text) => {
  const view = await mount(undefined, () => Promise.resolve(response({ enabled: false, reason })));
  expect(screen.getByText(text, { exact: false })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); expect(view.commands()).toHaveLength(0);
});
test.each([[409, 'TV_UNAVAILABLE', 'Телевизор недоступен'], [409, 'TV_BUSY', 'Телевизор занят'], [422, 'UNSUPPORTED_CAPABILITY', 'Управление кнопками не поддерживается'], [503, 'COMMAND_NOT_SENT', 'Команда не отправлена'], [429, 'RATE_LIMITED', 'Слишком много команд'], [504, 'COMMAND_RESULT_UNKNOWN', unknown]])('command HTTP %s %s shows its safe outcome without raw server text', async (status, code, text) => {
  await mount((input) => Promise.resolve(response({ id: input.id, outcome: status === 504 ? 'unknown' : 'rejected', error: { code, message: 'synthetic private server detail' } }, status)));
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain(text); expect(screen.queryByText('synthetic private server detail')).toBeNull();
});
test.each(['network', 'malformed', 'wrong-id', 'wrong-status', 'unexpected-field', 'bad-error'])('post %s is unknown without retry or false sent claim', async (mode) => {
  const view = await mount((input) => mode === 'network' ? Promise.reject(new Error('synthetic transport loss')) : Promise.resolve(response(mode === 'malformed' ? {} : mode === 'bad-error' ? { id: input.id, outcome: 'rejected', error: { code: 'TV_BUSY', message: 'safe' } } : { id: mode === 'wrong-id' ? '11111111-1111-4111-8111-111111111111' : input.id, outcome: 'sent', ...(mode === 'unexpected-field' ? { clientKey: 'synthetic-secret' } : {}) }, mode === 'wrong-status' ? 504 : mode === 'bad-error' ? 503 : 200)));
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toBe(unknown); expect(screen.queryByText('Команда отправлена')).toBeNull(); expect(view.commands()).toHaveLength(1);
});
test.each(['read', 'command'])('401 from %s expires the session', async (mode) => {
  const expired = vi.fn(); const unauthorized = () => Promise.resolve(response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401));
  await mount(mode === 'command' ? unauthorized : undefined, mode === 'read' ? unauthorized : undefined, expired);
  if (mode === 'command') { fireEvent.click(screen.getByRole('button', { name: 'OK' })); await act(async () => {}); }
  expect(expired).toHaveBeenCalledTimes(1);
});
test('remote reads have completion cooldown, never overlap, refresh after commands and stop on logout', async () => {
  vi.useFakeTimers(); const pending = barrier<Response>(); let count = 0;
  const view = await mount(undefined, () => ++count === 2 ? pending.promise : Promise.resolve(response(ready)));
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); }); expect(view.reads()).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(view.reads()).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(view.reads()).toHaveLength(2);
  await act(async () => { pending.resolve(response(ready)); });
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); }); expect(view.reads()).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(view.reads()).toHaveLength(3);
  view.rerender(home(false)); const reads = view.reads().length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(view.reads()).toHaveLength(reads); expect(screen.queryByRole('group', { name: 'Пульт' })).toBeNull();
});
test.each(['sent', '401'])('logout aborts command and late %s cannot alter a new session', async (mode) => {
  const pending = barrier<Response>(); const expired = vi.fn(); const view = await mount(() => pending.promise, undefined, expired);
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); const init = view.commands()[0]![1]!;
  view.rerender(home(false, expired)); expect((init.signal as AbortSignal).aborted).toBe(true);
  view.rerender(home(true, expired)); await act(async () => {});
  await act(async () => { pending.resolve(mode === '401' ? response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401) : response({ id: JSON.parse(init.body as string).id, outcome: 'sent' })); });
  expect(screen.queryByText('Команда отправлена')).toBeNull(); expect(expired).not.toHaveBeenCalled();
});
test('logout aborts capability read and ignores its late 401', async () => {
  const pending = barrier<Response>(); const expired = vi.fn(); const view = await mount(undefined, () => pending.promise, expired);
  const signal = view.reads()[0]![1]!.signal as AbortSignal;
  view.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401)); }); expect(expired).not.toHaveBeenCalled();
});

test('unconfirmed or malformed capability disables all commands until a fresh successful read', async () => {
  vi.useFakeTimers(); const pending = barrier<Response>(); let count = 0;
  const view = await mount(undefined, () => ++count === 1 ? pending.promise : Promise.resolve(response(ready)));
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); expect(view.commands()).toHaveLength(0);
  await act(async () => { pending.resolve(response({ enabled: true, reason: null, clientKey: 'synthetic-secret' })); });
  expect(screen.getByText('Не удалось проверить доступность пульта. Ожидаем обновления статуса.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); expect(view.commands()).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); await act(async () => {}); expect(view.commands()).toHaveLength(1);
});
test('consecutive explicit commands get distinct IDs while a lost response is never retried', async () => {
  const view = await mount(() => Promise.reject(new Error('synthetic response loss')));
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); await act(async () => {});
  expect(view.commands()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); await act(async () => {});
  expect(view.commands()).toHaveLength(2);
  expect(JSON.parse(view.commands()[0]![1]!.body as string).id).not.toBe(JSON.parse(view.commands()[1]![1]!.body as string).id);
});
test.each([400, 403])('auth/schema HTTP %s is a safe pre-send rejection', async (status) => {
  await mount(() => Promise.resolve(response({ code: 'INVALID_REQUEST', message: 'synthetic private detail', requestId: 'synthetic' }, status)));
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('Команда отклонена'); expect(screen.queryByText(unknown)).toBeNull();
});
test('direct active/token lifecycle stops polls and ignores old command even when the component is retained', async () => {
  vi.useFakeTimers(); const pending = barrier<Response>(); const expired = vi.fn();
  const fetch = vi.fn((path: string, _init?: RequestInit) => path === '/api/tv/remote' ? Promise.resolve(response(ready)) : pending.promise);
  vi.stubGlobal('fetch', fetch);
  const view = render(<Remote csrfToken={csrfToken} active onSessionExpired={expired} />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); const signal = fetch.mock.calls[1]![1]?.signal as AbortSignal;
  view.rerender(<Remote csrfToken={csrfToken} active={false} onSessionExpired={expired} />); expect(signal.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender(<Remote csrfToken={'d'.repeat(43)} active onSessionExpired={expired} />); await act(async () => {});
  await act(async () => { pending.resolve(response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401)); });
  expect(expired).not.toHaveBeenCalled(); expect(screen.queryByRole('alert')).toBeNull();
});

test('App logout removes pending remote, then a late unauthorized command cannot expire the new login', async () => {
  const pending = barrier<Response>(); let sessions = 0;
  const fetch = vi.fn((path: string, _init?: RequestInit) => {
    switch (path) {
      case '/api/setup/status': return Promise.resolve(response({ state: 'claimed' }));
      case '/api/auth/session': return Promise.resolve(response({ username: 'alice', csrfToken: ++sessions === 1 ? csrfToken : 'd'.repeat(43) }));
      case '/api/auth/login': return Promise.resolve(response({ username: 'alice' }));
      case '/api/auth/logout': return Promise.resolve(new Response(null, { status: 204 }));
      case '/api/tv': return Promise.resolve(response(saved));
      case '/api/tv/remote': return Promise.resolve(response(ready));
      case '/api/tv/commands': return pending.promise;
      default: throw new Error('Unexpected test route');
    }
  });
  vi.stubGlobal('fetch', fetch); render(<App />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'OK' })); const command = fetch.mock.calls.find(([path]) => path === '/api/tv/commands')!;
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' })); expect((command[1]!.signal as AbortSignal).aborted).toBe(true);
  expect(screen.queryByRole('group', { name: 'Пульт' })).toBeNull(); await act(async () => {});
  fireEvent.change(screen.getByLabelText('Имя владельца'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'correct horse battery staple' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Войти' }).closest('form')!); await act(async () => {});
  await act(async () => { pending.resolve(response({ code: 'UNAUTHORIZED', message: 'Unauthorized', requestId: 'synthetic' }, 401)); });
  expect(screen.getByRole('group', { name: 'Пульт' })).toBeTruthy(); expect(screen.queryByRole('heading', { name: 'Вход' })).toBeNull();
  expect(screen.queryByText('Сессия истекла. Войдите снова.')).toBeNull();
});
