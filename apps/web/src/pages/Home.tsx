import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TvSetup } from './TvSetup.js';

interface Props { username: string; csrfToken: string; tvActive: boolean; busy: boolean; error: ReactNode; onLogout(): void; onSessionExpired(): void }
export function Home({ username, csrfToken, tvActive, busy, error, onLogout, onSessionExpired }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmingPower, setConfirmingPower] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!tvActive) { setSettingsOpen(false); setConfirmingPower(false); } }, [tvActive]);
  return <section>
    <header className="app-header">
      <p className="eyebrow">Remote WebOS TV</p>
      <div className="header-actions">
        <button ref={settingsButton} type="button" aria-label="Настройки" aria-haspopup="dialog" disabled={!tvActive || confirmingPower} onClick={() => { settingsButton.current?.focus(); setSettingsOpen(true); }}>⚙</button>
        <button type="button" disabled={busy} onClick={onLogout}>{busy ? 'Выход…' : 'Выйти'}</button>
      </div>
    </header>
    <p>Вы вошли как {username}.</p>
    {tvActive && <TvSetup csrfToken={csrfToken} settingsOpen={settingsOpen} onCloseSettings={() => setSettingsOpen(false)} onConfirmationChange={setConfirmingPower} onSessionExpired={onSessionExpired} />}
    {error}
  </section>;
}
