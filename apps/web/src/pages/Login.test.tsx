import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Login } from './Login.js';

afterEach(cleanup);
test.each([
  ['', '', 'Введите логин.', 'Введите пароль.'],
  ['a'.repeat(65), 'short', 'Логин: от 1 до 64 символов.', 'Пароль: от 12 до 128 символов.'],
  ['alice', 'a'.repeat(129), null, 'Пароль: от 12 до 128 символов.'],
])('invalid fields stay local and point to the relevant inputs', (username, password, loginError, passwordError) => {
  const submit = vi.fn(); render(<Login busy={false} error={null} onSubmit={submit} />);
  fireEvent.change(screen.getByLabelText('Логин'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: password } });
  fireEvent.submit(screen.getByRole('button', { name: 'Войти' }).closest('form')!);
  expect(submit).not.toHaveBeenCalled();
  for (const [label, message] of [['Логин', loginError], ['Пароль', passwordError]]) {
    const input = screen.getByLabelText(label!);
    expect(input.getAttribute('aria-invalid')).toBe(message ? 'true' : 'false');
    if (message) expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(message);
  }
  expect(document.activeElement).toBe(screen.getByLabelText(loginError ? 'Логин' : 'Пароль'));
});

test('Unicode boundary values are submitted unchanged without native UTF-16 limits', () => {
  const submit = vi.fn(); render(<Login busy={false} error={null} onSubmit={submit} />);
  const username = '😀'.repeat(64), password = '😀'.repeat(12);
  fireEvent.change(screen.getByLabelText('Логин'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: password } });
  fireEvent.submit(screen.getByRole('button', { name: 'Войти' }).closest('form')!);
  expect(submit).toHaveBeenCalledWith({ username, password });
});
