import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TvSetup } from './TvSetup.js';
import { IconInfoCircle, IconSettings } from '@tabler/icons-react';
import { LogoutConfirmation } from '../components/LogoutConfirmation.js';

interface Props { username: string; csrfToken: string; tvActive: boolean; busy: boolean; error: ReactNode; onLogout(): void; onSessionExpired(): void }
export function Home({ username, csrfToken, tvActive, busy, error, onLogout, onSessionExpired }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [confirmingPower, setConfirmingPower] = useState(false);
  const [identityTarget, setIdentityTarget] = useState<HTMLDivElement | null>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const logoutButton = useRef<HTMLButtonElement>(null);
  const help = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function dismissHelp(event: PointerEvent) {
      if (event.target instanceof Node && !help.current?.contains(event.target) && help.current) help.current.open = false;
    }
    document.addEventListener('pointerdown', dismissHelp);
    return () => document.removeEventListener('pointerdown', dismissHelp);
  }, []);
  useEffect(() => { if ((settingsOpen || confirmingPower || confirmingLogout) && help.current) help.current.open = false; }, [settingsOpen, confirmingPower, confirmingLogout]);
  useEffect(() => { if (!tvActive) { setSettingsOpen(false); setConfirmingPower(false); } }, [tvActive]);
  return <section>
    <header className="app-header">
      <div className="header-identity"><p className="eyebrow">Smart TV Remote Hub</p><div ref={setIdentityTarget} /></div>
      <div className="header-actions">
        <details ref={help} className="keyboard-help"><summary aria-label="Управление с клавиатуры" title="Управление с клавиатуры"><IconInfoCircle aria-hidden="true" /></summary><div id="remote-help" className="help-panel">
          <p>Нажмите Tab, чтобы перейти к пульту, или нажмите на свободное место внутри него.</p>
          <dl className="keyboard-shortcuts">
            <div><dt><kbd>↑ ↓ ← →</kbd></dt><dd>Навигация</dd></div>
            <div><dt><kbd>Enter</kbd></dt><dd>OK</dd></div>
            <div><dt><kbd>Escape</kbd></dt><dd>Назад</dd></div>
            <div><dt><kbd>Home</kbd></dt><dd>Домой</dd></div>
            <div><dt><kbd>+</kbd></dt><dd>Громче</dd></div>
            <div><dt><kbd>−</kbd></dt><dd>Тише</dd></div>
            <div><dt><kbd>M</kbd></dt><dd>Без звука</dd></div>
          </dl>
        </div></details>
        <button ref={settingsButton} type="button" aria-label="Настройки" title="Настройки" aria-haspopup="dialog" disabled={!tvActive || confirmingPower} onClick={() => { settingsButton.current?.focus(); setSettingsOpen(true); }}><IconSettings aria-hidden="true" /></button>
        <button ref={logoutButton} type="button" aria-haspopup="dialog" disabled={busy || confirmingPower} onClick={() => { setSettingsOpen(false); setConfirmingLogout(true); }}>{busy ? 'Выход…' : 'Выйти'}</button>
      </div>
    </header>
    <LogoutConfirmation open={confirmingLogout && !busy} anchor={logoutButton} onClose={() => setConfirmingLogout(false)} onConfirm={() => { setConfirmingLogout(false); onLogout(); }} />
    {tvActive && <TvSetup username={username} csrfToken={csrfToken} identityTarget={identityTarget} settingsOpen={settingsOpen} onCloseSettings={() => setSettingsOpen(false)} onConfirmationChange={setConfirmingPower} onSessionExpired={onSessionExpired} />}
    {error}
  </section>;
}
