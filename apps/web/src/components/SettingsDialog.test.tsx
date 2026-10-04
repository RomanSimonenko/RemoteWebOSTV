import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsDialog } from './SettingsDialog.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) },
    close: { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = false; }) },
  });
});

test('opens natively, stays mounted on close, and returns focus to its opener', () => {
  const close = vi.fn();
  const view = render(<><button>Настройки</button><SettingsDialog open={false} onClose={close}><input aria-label="Draft" /></SettingsDialog></>);
  const opener = screen.getByRole('button', { name: 'Настройки' }); opener.focus();
  const input = screen.getByLabelText('Draft');
  view.rerender(<><button>Настройки</button><SettingsDialog open onClose={close}><input aria-label="Draft" /></SettingsDialog></>);
  expect(screen.getByRole('dialog', { name: 'Настройки телевизора' })).toBeTruthy();
  expect(document.activeElement?.closest('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть настройки' })); expect(close).toHaveBeenCalledTimes(1);
  view.rerender(<><button>Настройки</button><SettingsDialog open={false} onClose={close}><input aria-label="Draft" /></SettingsDialog></>);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByLabelText('Draft')).toBe(input); expect(document.activeElement).toBe(opener);
});

test('Escape cancel delegates closing without unmounting content', () => {
  const close = vi.fn(); render(<SettingsDialog open onClose={close}>Settings</SettingsDialog>);
  const event = new Event('cancel', { bubbles: false, cancelable: true });
  fireEvent(screen.getByRole('dialog'), event); expect(close).toHaveBeenCalledTimes(1); expect(event.defaultPrevented).toBe(true);
});
