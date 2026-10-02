import { useState, type FormEvent, type ReactNode } from 'react';
import type { LoginRequest } from '@remote-webos-tv/contracts';

interface Props { busy: boolean; error: ReactNode; feedback?: string | undefined; onSubmit(input: LoginRequest): void }
export function Login({ busy, error, feedback, onSubmit }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!busy) onSubmit({ username, password }); }
  return <section>
    <h1>Вход</h1>
    {feedback && <p role="status">{feedback}</p>}
    <form onSubmit={submit}>
      <label>Имя владельца<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label>
      <label>Пароль<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>
      {error}
      <p role="status" aria-live="polite">{busy ? 'Выполняется вход…' : ''}</p>
      <button disabled={busy} type="submit">{busy ? 'Вход…' : 'Войти'}</button>
    </form>
  </section>;
}
