import { useState, type ReactNode, type FormEvent } from 'react';
import type { SetupRequest } from '@remote-webos-tv/contracts';

interface Props { busy: boolean; error: ReactNode; onSubmit(input: SetupRequest): void }
export function Setup({ busy, error, onSubmit }: Props) {
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!busy) onSubmit({ token, username, password }); }
  return <section>
    <h1>Первичная настройка</h1>
    <p>Введите одноразовый токен из терминала и создайте владельца.</p>
    <form onSubmit={submit}>
      <label>Установочный токен<input value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" required /></label>
      <label>Имя владельца<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" maxLength={64} required /></label>
      <label>Пароль<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
      {error}
      <p role="status" aria-live="polite">{busy ? 'Создаём владельца…' : ''}</p>
      <button disabled={busy} type="submit">{busy ? 'Создание…' : 'Создать владельца'}</button>
    </form>
  </section>;
}
