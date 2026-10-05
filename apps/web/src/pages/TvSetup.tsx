import { useEffect, useRef, useState } from 'react';
import { startTvOperationSchema, type StartTvOperation, type TvConnectionState, type TvOperation, type SavedTvView, type TvPowerState } from '@remote-webos-tv/contracts';
import { api, ApiFailure, friendlyError } from '../api.js';
import { useTvStatus } from '../useTvStatus.js';
import { Remote } from './Remote.js';
import { PowerControls } from './PowerControls.js';
import { SettingsDialog } from '../components/SettingsDialog.js';

interface Props { username?: string; csrfToken: string; onSessionExpired(): void; settingsOpen: boolean; onCloseSettings(): void; onConfirmationChange?(confirming: boolean): void }
const connections: Record<TvConnectionState, string> = {
  unconfigured: 'Введите IP-адрес телевизора', pairing: 'Сопряжение', connecting: 'Подключение',
  available: 'Подключён', unavailable: 'Нет соединения', reconnecting: 'Подключение',
  authorization_error: 'Ошибка авторизации', compatibility_error: 'Ошибка совместимости',
};

export function TvSetup({ username, csrfToken, onSessionExpired, settingsOpen, onCloseSettings, onConfirmationChange }: Props) {
  const { status, statusReadVersion, getReadVersion, loading, refreshing, error, refresh } = useTvStatus(onSessionExpired);
  const [host, setHost] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [powerState, setPowerState] = useState<TvPowerState | null>(null);
  const [powerBusy, setPowerBusy] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<HTMLDivElement | null>(null);
  const [powerActivityTarget, setPowerActivityTarget] = useState<HTMLDivElement | null>(null);
  const [remoteActivityTarget, setRemoteActivityTarget] = useState<HTMLDivElement | null>(null);
  const [accepted, setAccepted] = useState<{ operation: TvOperation; afterReadVersion: number } | null>(null);
  const [now, setNow] = useState(Date.now);
  const saved = useRef<SavedTvView | null>(null);
  const pending = useRef(false);
  const active = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  if (status) saved.current = status.tv;
  const tv = saved.current;
  // Reads started before the mutation response may carry a previous snapshot.
  // A read started afterwards is authoritative even if another tab replaced the
  // operation. Opaque server ids and wall-clock timestamps do not order reads.
  const observed = status?.operation;
  const hasObservedAccepted = accepted && status && statusReadVersion > accepted.afterReadVersion;
  const operation = accepted && !hasObservedAccepted ? accepted.operation : observed;
  const running = operation?.status === 'running';
  const powerRunning = powerState?.operation?.status === 'running';
  const controlsBusy = busy || powerRunning;
  const activityBusy = refreshing || busy || running || powerBusy || remoteBusy;
  const [showActivity, setShowActivity] = useState(false);
  useEffect(() => {
    if (!activityBusy) { setShowActivity(false); return; }
    const timer = setTimeout(() => setShowActivity(true), 400);
    return () => clearTimeout(timer);
  }, [activityBusy]);
  const progress = running ? (operation.action === 'pair' || operation.action === 'repair' ? 'Сопряжение' : 'Подключение') : null;
  const diagnostic = message || error || status?.error?.message || operation?.error?.message || '';

  useEffect(() => {
    if (hasObservedAccepted) setAccepted(null);
  }, [hasObservedAccepted]);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, operation?.deadlineAt]);
  // Opening or closing presentation alone must not refocus a historical error.
  useEffect(() => { if (diagnostic && !settingsOpen) alert.current?.focus({ preventScroll: true }); }, [diagnostic]);
  useEffect(() => { if (settingsOpen && tv) setHost(tv.host); }, [settingsOpen, tv?.host]);

  async function mutate(action: (signal: AbortSignal) => Promise<TvOperation>) {
    if (pending.current) return;
    pending.current = true;
    controller.current = new AbortController();
    setBusy(true); setMessage('');
    try {
      const next = await action(controller.current.signal);
      if (!active.current) return;
      setAccepted({ operation: next, afterReadVersion: getReadVersion() });
      refresh();
    } catch (cause) {
      if (!active.current) return;
      if (cause instanceof ApiFailure && cause.status === 401) onSessionExpired();
      else setMessage(friendlyError(cause));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  function start(input: StartTvOperation) {
    if (pending.current || running || powerRunning) return;
    const parsed = startTvOperationSchema.safeParse(input);
    if (!parsed.success) { setMessage('Введите буквальный IPv4-адрес частной локальной сети (например, 192.168.1.20).'); return; }
    void mutate((signal) => api.startTvOperation(parsed.data, csrfToken, signal));
  }

  const connectionText = error ? 'Статус неизвестен' : progress || (status ? connections[status.connection] : 'Загрузка статуса…');
  // Keep autofocus ownership on the retained background diagnostic, separate
  // from the modal copy that unmounts when settings close.
  const activity = (withFocusRef: boolean) => <>
    {diagnostic && <p ref={withFocusRef ? alert : undefined} tabIndex={-1} role="alert" className="error">{diagnostic}</p>}
    {running && !powerRunning && <div>
      {(operation.action === 'pair' || operation.action === 'repair') && <p>Подтвердите доступ на экране телевизора.</p>}
      <p>Осталось: {Math.max(0, Math.ceil((operation.deadlineAt - now) / 1000))} с</p>
      <button type="button" disabled={busy} onClick={() => void mutate((signal) => api.cancelTvOperation(operation.id, csrfToken, signal))}>Отменить</button>
    </div>}
  </>;
  const addressForm = status && !running && <>
    {!tv && <p>Телевизор должен быть включён и доступен серверу. Разрешите управление мобильными устройствами в настройках ТВ.</p>}
    <form onSubmit={(event) => { event.preventDefault(); start({ action: tv ? 'change_address' : 'pair', host }); }} noValidate>
      <label>IP-адрес телевизора<input inputMode="decimal" autoComplete="off" value={host} disabled={controlsBusy} onChange={(event) => setHost(event.target.value)} /></label>
      <button className="settings-primary" type="submit" disabled={controlsBusy}>{tv ? 'Изменить адрес' : 'Подключить'}</button>
    </form>
    {tv && <div className="settings-actions">
      <button type="button" disabled={controlsBusy} onClick={() => start({ action: 'reconnect' })}>Подключиться снова</button>
      <button type="button" disabled={controlsBusy} onClick={() => start({ action: 'repair' })}>Повторить сопряжение</button>
    </div>}
  </>;
  return <section className={tv ? 'tv-layout' : 'form-card'}>
    {!tv && <h1>Телевизор ещё не настроен</h1>}
    {tv && <div className="tv-card">
      <div className="tv-info"><img className="tv-brand" src="/lg-logo.svg" alt="LG" /><p className="tv-model">{tv.identity.model}</p></div>
      <PowerControls csrfToken={csrfToken} active settingsOpen={settingsOpen} settingsTarget={settingsTarget} activityTarget={powerActivityTarget} {...(onConfirmationChange ? { onConfirmationChange } : {})} onSessionExpired={onSessionExpired} onStateChange={setPowerState} onBusyChange={setPowerBusy} />
      <Remote csrfToken={csrfToken} active interactionBlocked={settingsOpen} activityTarget={remoteActivityTarget} onSessionExpired={onSessionExpired} onBusyChange={setRemoteBusy} />
    </div>}
    <div className="tv-activity">
      <div className="connection-row"><p className="connection-status" data-connection={error ? 'unknown' : status?.connection} role="status" aria-label="Соединение с телевизором" aria-live="polite">{connectionText}</p><span className="activity-slot">{activityBusy && showActivity && <span className="activity-spinner" role="img" aria-label="Выполняется запрос" />}</span></div>
      <div className={settingsOpen ? 'reserved-activity' : undefined} aria-hidden={settingsOpen || undefined} inert={settingsOpen}>{activity(true)}</div>
      <div className="power-activity" ref={setPowerActivityTarget} />
      <div ref={setRemoteActivityTarget} />
    </div>
    {!tv && <>{addressForm}<button type="button" disabled={loading} onClick={refresh}>Обновить статус</button></>}
    <SettingsDialog open={settingsOpen} onClose={onCloseSettings}>
      {tv ? <><section className="settings-section">
        {settingsOpen && username && <p className="session-caption">Вы вошли как {username}.</p>}
        <p className="settings-identity"><span className="settings-model">Модель: {tv.identity.model}</span>{settingsOpen && <span className="tv-version">{tv.identity.platformVersion ? `webOS ${tv.identity.platformVersion}` : 'Версия неизвестна'}</span>}</p>
      </section><section className="settings-section"><h3>Подключение</h3>
        {settingsOpen && activity(false)}<p>Соединение: {connectionText}</p><p>Сохранённый IP: {tv.host}</p>{addressForm}
        <button type="button" disabled={loading} onClick={refresh}>Обновить статус</button>
      </section></> : <>{settingsOpen && username && <p className="session-caption">Вы вошли как {username}.</p>}{settingsOpen && activity(false)}<p>Добавьте телевизор на основном экране.</p></>}
      <div ref={setSettingsTarget} />
    </SettingsDialog>
  </section>;
}
