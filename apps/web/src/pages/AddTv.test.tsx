import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AddTv } from './AddTv.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test('LG addition requires a manual MAC and sends it with the selected TV', async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ code: 'BAD_REQUEST', message: 'Synthetic rejection' }), { status: 400 });
  }));
  render(<AddTv csrfToken="synthetic-csrf" onSessionExpired={vi.fn()} onReady={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('IP-адрес телевизора'), { target: { value: '10.2.3.4' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Подключить' }).closest('form')!); });
  expect(bodies).toEqual([]);
  expect(screen.getByRole('alert').textContent).toContain('MAC');
  fireEvent.change(screen.getByLabelText(/MAC-адрес телевизора/), { target: { value: '02-ab-cd-ef-00-01' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Подключить' }).closest('form')!); });
  expect(bodies).toEqual([expect.objectContaining({ platform: 'webos', host: '10.2.3.4', mac: '02:AB:CD:EF:00:01' })]);
});
test('Samsung addition does not show the LG MAC field', () => {
  render(<AddTv csrfToken="synthetic-csrf" onSessionExpired={vi.fn()} onReady={vi.fn()} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tizen' } });
  expect(screen.queryByLabelText(/MAC-адрес телевизора/)).toBeNull();
});
