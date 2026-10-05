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
        <details className="keyboard-help"><summary aria-label="Управление с клавиатуры" title="Управление с клавиатуры">?</summary><p id="remote-help">Клавиатура при фокусе на пульте: стрелки, Enter — OK, Escape — назад, Home — домой, +/− — громкость, M — без звука.</p></details>
        <button ref={settingsButton} type="button" aria-label="Настройки" title="Настройки" aria-haspopup="dialog" disabled={!tvActive || confirmingPower} onClick={() => { settingsButton.current?.focus(); setSettingsOpen(true); }}><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.2 2.2m9.8 9.8 2.2 2.2M4.9 19.1l2.2-2.2m9.8-9.8 2.2-2.2" /></svg></button>
        <button type="button" disabled={busy} onClick={onLogout}>{busy ? 'Выход…' : 'Выйти'}</button>
      </div>
    </header>
    <p className="session-caption">Вы вошли как {username}.</p>
    {tvActive && <TvSetup csrfToken={csrfToken} settingsOpen={settingsOpen} onCloseSettings={() => setSettingsOpen(false)} onConfirmationChange={setConfirmingPower} onSessionExpired={onSessionExpired} />}
    {error}
  </section>;
}
