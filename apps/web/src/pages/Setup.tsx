import { useState, type ReactNode, type FormEvent } from 'react';
import { setupRequestSchema, type SetupRequest } from '@remote-webos-tv/contracts';

interface Props { busy: boolean; error: ReactNode; onSubmit(input: SetupRequest): void }
export function Setup({ busy, error, onSubmit }: Props) {
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const parsed = setupRequestSchema.safeParse({ token, username, password });
    if (!parsed.success) {
      setValidationError('Проверьте токен и длину полей. Имя: 1–64 символа, пароль: 12–128.');
      return;
    }
    setValidationError('');
    onSubmit(parsed.data);
  }
  return <section className="form-card">
    <h1>Первичная настройка</h1>
    <p>Введите одноразовый токен из терминала и создайте владельца.</p>
    <details className="setup-token-help"><summary>Где получить токен?</summary>
      <p>В терминале, из каталога проекта, выполните команду для своего способа запуска:</p>
      <p>Docker Compose:</p><code>docker compose exec app node apps/api/dist/src/auth/cli.js setup-token</code>
      <p>Запуск из исходников:</p><code>pnpm --filter @remote-webos-tv/api setup-token</code>
      <p>Используйте ту же конфигурацию, что и при запуске приложения, включая имя проекта Compose, если задавали его. Токен действует 15 минут. Не передавайте его другим.</p>
    </details>
    <form onSubmit={submit}>
      <label>Установочный токен<input value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" required /></label>
      <label>Имя владельца<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" aria-describedby="setup-lengths" required /></label>
      <label>Пароль<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="new-password" aria-describedby="setup-lengths" required /></label>
      <p id="setup-lengths">Имя: от 1 до 64 символов. Пароль: от 12 до 128 символов.</p>
      {validationError ? <p role="alert">{validationError}</p> : error}
      <p role="status" aria-live="polite">{busy ? 'Создаём владельца…' : ''}</p>
      <button className="settings-primary" disabled={busy} type="submit">{busy ? 'Создание…' : 'Создать владельца'}</button>
    </form>
  </section>;
}
