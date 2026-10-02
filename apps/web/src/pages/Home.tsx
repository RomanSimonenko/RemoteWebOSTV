import type { ReactNode } from 'react';

interface Props { username: string; busy: boolean; error: ReactNode; onLogout(): void }
export function Home({ username, busy, error, onLogout }: Props) {
  return <section>
    <h1>Телевизор ещё не настроен</h1>
    <p>Вы вошли как {username}. Настройка телевизора появится позже.</p>
    {error}
    <button type="button" disabled={busy} onClick={onLogout}>{busy ? 'Выход…' : 'Выйти'}</button>
  </section>;
}
