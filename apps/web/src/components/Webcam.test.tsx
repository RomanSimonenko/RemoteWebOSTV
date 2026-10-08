import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Webcam } from './Webcam.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function media(getUserMedia = vi.fn()) {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput', deviceId: 'one', label: 'Camera One' }, { kind: 'videoinput', deviceId: 'two', label: 'Camera Two' }]) } });
  return getUserMedia;
}
function stream() { const stop = vi.fn(); return { value: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop }; }
test('starts only on request, switches the selected camera and releases it on unmount', async () => {
  const first = stream(), second = stream();
  const get = media(vi.fn().mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value));
  const view = render(<Webcam />);
  expect(get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Включить' }));
  await waitFor(() => expect(view.container.querySelector('video')?.srcObject).toBe(first.value));
  expect(get).toHaveBeenCalledWith({ audio: false, video: true });
  fireEvent.change(screen.getByLabelText('Камера'), { target: { value: 'two' } });
  await waitFor(() => expect(view.container.querySelector('video')?.srcObject).toBe(second.value));
  expect(first.stop).toHaveBeenCalledOnce();
  expect(get).toHaveBeenLastCalledWith({ audio: false, video: { deviceId: { exact: 'two' } } });
  view.unmount(); expect(second.stop).toHaveBeenCalledOnce();
});
test('stopping during permission request releases a late stream', async () => {
  let resolve!: (value: MediaStream) => void;
  media(vi.fn().mockReturnValue(new Promise<MediaStream>((done) => { resolve = done; })));
  const view = render(<Webcam />);
  fireEvent.click(screen.getByRole('button', { name: 'Включить' }));
  fireEvent.click(screen.getByRole('button', { name: 'Выключить' }));
  const late = stream(); await act(async () => resolve(late.value));
  expect(late.stop).toHaveBeenCalledOnce(); expect(view.container.querySelector('video')?.srcObject).toBeFalsy();
});
test('permission denial is visible and allows retry', async () => {
  media(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')));
  render(<Webcam />); fireEvent.click(screen.getByRole('button', { name: 'Включить' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Включить' }) as HTMLButtonElement).disabled).toBe(false);
});
test('unsupported browser explains why the camera cannot start', () => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  render(<Webcam />); expect(screen.getByText(/Браузер не предоставляет/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Включить' }) as HTMLButtonElement).disabled).toBe(true);
});

test('waiting feedback is delayed and cancelled when access resolves quickly', async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: MediaStream) => void;
    media(vi.fn().mockReturnValue(new Promise<MediaStream>((done) => { resolve = done; })));
    render(<Webcam />);
    fireEvent.click(screen.getByRole('button', { name: 'Включить' }));
    expect(screen.queryByText('Ожидаем доступ к камере…')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(399); });
    expect(screen.queryByText('Ожидаем доступ к камере…')).toBeNull();
    await act(async () => resolve(stream().value));
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText('Ожидаем доступ к камере…')).toBeNull();
  } finally { vi.useRealTimers(); }
});
test('slow permission shows waiting feedback and stopping clears its timer', async () => {
  vi.useFakeTimers();
  try {
    media(vi.fn().mockReturnValue(new Promise<MediaStream>(() => {})));
    render(<Webcam />);
    fireEvent.click(screen.getByRole('button', { name: 'Включить' }));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByText('Ожидаем доступ к камере…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Выключить' }));
    expect(screen.queryByText('Ожидаем доступ к камере…')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
