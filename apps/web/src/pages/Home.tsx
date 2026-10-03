import type { ReactNode } from 'react';
import { TvSetup } from './TvSetup.js';

interface Props { username: string; csrfToken: string; tvActive: boolean; busy: boolean; error: ReactNode; onLogout(): void; onSessionExpired(): void }
export function Home({ username, csrfToken, tvActive, busy, error, onLogout, onSessionExpired }: Props) {
  return <section>
    <p>Вы вошли как {username}.</p>
    {tvActive && <TvSetup csrfToken={csrfToken} onSessionExpired={onSessionExpired} />}
    {error}
    <button type="button" disabled={busy} onClick={onLogout}>{busy ? 'Выход…' : 'Выйти'}</button>
  </section>;
}
