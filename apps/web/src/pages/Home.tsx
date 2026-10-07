import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TvSetup } from './TvSetup.js';
import { IconArrowLeft, IconInfoCircle, IconSettings } from '@tabler/icons-react';
import { LogoutConfirmation } from '../components/LogoutConfirmation.js';
import { SettingsDialog } from '../components/SettingsDialog.js';
import { useTvStatus } from '../useTvStatus.js';
import { Dashboard } from './Dashboard.js';
import { useTvDevices } from '../useTvDevices.js';
import type { TvId } from '@remote-webos-tv/contracts';
import { AddTv } from './AddTv.js';
import { api, ApiFailure } from '../api.js';

interface Props { username: string; csrfToken: string; tvActive: boolean; busy: boolean; error: ReactNode; onLogout(): void; onSessionExpired(): void }
export function Home({ username, csrfToken, tvActive, busy, error, onLogout, onSessionExpired }: Props) {
  const props = { username, csrfToken, tvActive, busy, error, onLogout, onSessionExpired };
  return <HomeContent {...props} />;
}
function HomeContent({ username, csrfToken, tvActive, busy, error, onLogout, onSessionExpired }: Props) {
  const [screen, setScreen] = useState<'dashboard' | 'add' | 'remote'>('dashboard');
  const [tvId, setTvId] = useState<TvId | null>(null);
  const devicesState = useTvDevices(onSessionExpired, tvActive && screen === 'dashboard');
  const statusState = useTvStatus(onSessionExpired, tvId ?? undefined, tvActive && screen === 'remote' && tvId !== null);
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
  function navigate(next: typeof screen) {
    setSettingsOpen(false); setConfirmingPower(false); setScreen(next);
    if (help.current) help.current.open = false;
  }
  return <section className={screen === 'dashboard' ? 'dashboard-screen' : undefined}>
    <header className="app-header">
      <div className="header-identity"><p className="eyebrow">Smart TV Remote Hub</p><div ref={setIdentityTarget} /></div>
      <div className="header-actions">
        {screen === 'remote' && <details ref={help} className="keyboard-help"><summary aria-label="Управление с клавиатуры" title="Управление с клавиатуры"><IconInfoCircle aria-hidden="true" /></summary><div id="remote-help" className="help-panel">
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
        </div></details>}
        <button ref={settingsButton} type="button" aria-label="Настройки" title="Настройки" aria-haspopup="dialog" disabled={!tvActive || confirmingPower} onClick={() => { settingsButton.current?.focus(); setSettingsOpen(true); }}><IconSettings aria-hidden="true" /></button>
        <button ref={logoutButton} type="button" aria-haspopup="dialog" disabled={busy || confirmingPower} onClick={() => { setSettingsOpen(false); setConfirmingLogout(true); }}>{busy ? 'Выход…' : 'Выйти'}</button>
      </div>
    </header>
    <LogoutConfirmation open={confirmingLogout && !busy} anchor={logoutButton} onClose={() => setConfirmingLogout(false)} onConfirm={() => { setConfirmingLogout(false); onLogout(); }} />
    {tvActive && (screen === 'dashboard' ? <>
      <Dashboard devices={devicesState.devices} loading={devicesState.loading} error={devicesState.error} onRetry={devicesState.refresh} onOpenTv={(id) => { setTvId(id); navigate('remote'); }} onAddTv={() => navigate('add')} onDeleteTv={async (id, signal) => {
        try { await api.deleteTv(id, csrfToken, signal); devicesState.remove(id); }
        catch (cause) { devicesState.refresh(); if (cause instanceof ApiFailure && cause.status === 401) onSessionExpired(); throw cause; }
      }} />
      <SettingsDialog title="Настройки аккаунта" open={settingsOpen} onClose={() => setSettingsOpen(false)}><p className="session-caption">Вы вошли как {username}.</p></SettingsDialog>
    </> : <>
      <nav className="tv-navigation" aria-label="Телевизоры"><button type="button" disabled={confirmingPower} onClick={() => navigate('dashboard')}><IconArrowLeft aria-hidden="true" />Телевизоры</button></nav>
      {screen === 'add' ? <AddTv csrfToken={csrfToken} onSessionExpired={onSessionExpired} onReady={() => navigate('dashboard')} /> : tvId && <TvSetup key={tvId} tvId={tvId} username={username} csrfToken={csrfToken} identityTarget={identityTarget} statusState={statusState} settingsOpen={settingsOpen} onCloseSettings={() => setSettingsOpen(false)} onConfirmationChange={setConfirmingPower} onSessionExpired={onSessionExpired} />}
    </>)}
    {error}
  </section>;
}
