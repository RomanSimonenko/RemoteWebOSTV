import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TvSetup } from './TvSetup.js';
import { IconSettings } from '@tabler/icons-react';

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
        <button ref={settingsButton} type="button" aria-label="Настройки" title="Настройки" aria-haspopup="dialog" disabled={!tvActive || confirmingPower} onClick={() => { settingsButton.current?.focus(); setSettingsOpen(true); }}><IconSettings aria-hidden="true" /></button>
        <button type="button" disabled={busy} onClick={onLogout}>{busy ? 'Выход…' : 'Выйти'}</button>
      </div>
    </header>
    <p className="session-caption">Вы вошли как {username}.</p>
    {tvActive && <TvSetup csrfToken={csrfToken} settingsOpen={settingsOpen} onCloseSettings={() => setSettingsOpen(false)} onConfirmationChange={setConfirmingPower} onSessionExpired={onSessionExpired} />}
    {error}
  </section>;
}
