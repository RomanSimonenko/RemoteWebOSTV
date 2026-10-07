import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { startTvOperationSchema, type StartTvOperation, type TvOperation, type SavedTvView, type TvPowerState, type TvId } from '@remote-webos-tv/contracts';
import { api, ApiFailure, friendlyError } from '../api.js';
import { useTvStatus } from '../useTvStatus.js';
import { Remote } from './Remote.js';
import { PowerControls } from './PowerControls.js';
import { SettingsDialog } from '../components/SettingsDialog.js';
import { connectionLabels } from '../tv-connection.js';

interface Props { tvId?: TvId; onReady?(): void; username?: string; csrfToken: string; identityTarget?: HTMLElement | null; onSessionExpired(): void; settingsOpen: boolean; onCloseSettings(): void; onConfirmationChange?(confirming: boolean): void; statusState?: ReturnType<typeof useTvStatus> }

export function TvSetup(props: Props) {
  return props.statusState ? <TvSetupContent {...props} statusState={props.statusState} /> : <StandaloneTvSetup {...props} />;
}
function StandaloneTvSetup(props: Props) {
  const statusState = useTvStatus(props.onSessionExpired, props.tvId);
  return <TvSetupContent {...props} statusState={statusState} />;
}
function TvSetupContent({ tvId, onReady, username, csrfToken, identityTarget, onSessionExpired, settingsOpen, onCloseSettings, onConfirmationChange, statusState }: Props & { statusState: ReturnType<typeof useTvStatus> }) {
  const { status, statusReadVersion, getReadVersion, loading, refreshing, error, refresh } = statusState;
  const [host, setHost] = useState('');
  const [message, setMessage] = useState('');
  const [manualOperationId, setManualOperationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [powerObservation, setPowerObservation] = useState<{ lastOperation: TvPowerState['operation']; shutdownAfterReadVersion: number | null }>({ lastOperation: null, shutdownAfterReadVersion: null });
  const observePowerState = useCallback((state: TvPowerState | null) => {
    const readVersion = getReadVersion();
    setPowerObservation((previous) => {
      const oldOperation = previous.lastOperation;
      const operation = state?.operation;
      const completedShutdown = oldOperation?.action === 'power_off' && oldOperation.status === 'running' && operation?.id === oldOperation.id && operation.status !== 'running';
      return { lastOperation: state ? state.operation : previous.lastOperation, shutdownAfterReadVersion: completedShutdown ? readVersion : operation?.action === 'wake' ? null : previous.shutdownAfterReadVersion };
    });
  }, [getReadVersion]);
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
  useEffect(() => { if (status?.tv) onReady?.(); }, [status?.tv, onReady]);
  // Reads started before the mutation response may carry a previous snapshot.
  // A read started afterwards is authoritative even if another tab replaced the
  // operation. Opaque server ids and wall-clock timestamps do not order reads.
  const observed = status?.operation;
  const hasObservedAccepted = accepted && status && statusReadVersion > accepted.afterReadVersion;
  const operation = accepted && !hasObservedAccepted ? accepted.operation : observed;
  const running = operation?.status === 'running';
  // A failed power read does not establish that an observed operation ended.
  const observedPowerOperation = powerObservation.lastOperation;
  const powerRunning = observedPowerOperation?.status === 'running';
  // A connection read already in flight when shutdown completes can still
  // carry "available". Only a subsequently started read ends the transition.
  const awaitingShutdownStatus = powerObservation.shutdownAfterReadVersion !== null && statusReadVersion <= powerObservation.shutdownAfterReadVersion;
  const poweringOff = (powerRunning && observedPowerOperation.action === 'power_off') || awaitingShutdownStatus;
  const controlsBusy = busy || powerRunning;
  const activityBusy = refreshing || busy || running || powerBusy || remoteBusy || awaitingShutdownStatus;
  const [showActivity, setShowActivity] = useState(false);
  useEffect(() => {
    if (!activityBusy) { setShowActivity(false); return; }
    const timer = setTimeout(() => setShowActivity(true), 400);
    return () => clearTimeout(timer);
  }, [activityBusy]);
  const progress = running ? (operation.action === 'pair' || operation.action === 'repair' ? 'Сопряжение' : 'Подключение') : null;
  // Power controls own this terminal warning; the connection snapshot also
  // carries it, but must not announce the same result a second time.
  const connectionDiagnostic = (failure: TvOperation['error']) => failure?.code === 'POWER_OFF_UNCONFIRMED' ? '' : failure?.message;
  const diagnostic = message || error || connectionDiagnostic(status?.error) || connectionDiagnostic(operation?.error) || '';
  const quietOffline = status?.connection === 'unavailable';
  const quietRemoteUnavailable = quietOffline || poweringOff || powerRunning || status?.connection === 'connecting' || status?.connection === 'reconnecting';
  const connectionFailure = status?.error ?? operation?.error;
  const routineConnectionFailure = ['CONNECTION_LOST', 'RECOVERY_TIMEOUT', 'TV_UNAVAILABLE'].includes(connectionFailure?.code ?? '');
  const backgroundDiagnostic = quietOffline && routineConnectionFailure && !message && !error && operation?.id !== manualOperationId ? '' : diagnostic;

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
  useEffect(() => { if (backgroundDiagnostic && !settingsOpen) alert.current?.focus({ preventScroll: true }); }, [backgroundDiagnostic]);
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
      setManualOperationId(next.id);
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
    if (!parsed.success) { setMessage('Введите локальный IP-адрес телевизора в формате IPv4, например 192.168.1.20. Без ссылки и номера порта.'); return; }
    void mutate((signal) => api.startTvOperation(parsed.data, csrfToken, signal, tvId));
  }

  const connectionText = error ? 'Статус неизвестен' : poweringOff ? 'Выключение' : progress || (status ? connectionLabels[status.connection] : 'Загрузка статуса…');
  const connectionAppearance = error ? 'unknown' : poweringOff ? 'connecting' : status?.connection;
  // Keep autofocus ownership on the retained background diagnostic, separate
  // from the modal copy that unmounts when settings close.
  const activity = (withFocusRef: boolean) => <>
    {(withFocusRef ? backgroundDiagnostic : diagnostic) && <p ref={withFocusRef ? alert : undefined} tabIndex={-1} role="alert" className="error">{withFocusRef ? backgroundDiagnostic : diagnostic}</p>}
    {running && !powerRunning && <div>
      {(operation.action === 'pair' || operation.action === 'repair') && <p>Подтвердите доступ на экране телевизора.</p>}
      <p>Осталось: {Math.max(0, Math.ceil((operation.deadlineAt - now) / 1000))} с</p>
      <button type="button" disabled={busy} onClick={() => void mutate((signal) => api.cancelTvOperation(operation.id, csrfToken, signal, tvId))}>Отменить</button>
    </div>}
  </>;
  const addressForm = status && !running && <>
    {!tv && <p>Телевизор должен быть включён и доступен серверу. Разрешите управление мобильными устройствами в настройках ТВ.</p>}
    <form className={tv ? 'settings-edit-row' : undefined} onSubmit={(event) => { event.preventDefault(); start({ action: tv ? 'change_address' : 'pair', host }); }} noValidate>
      <label>IP-адрес телевизора<input inputMode="decimal" autoComplete="off" value={host} disabled={controlsBusy} onChange={(event) => setHost(event.target.value)} /></label>
      <button className="settings-primary" type="submit" disabled={controlsBusy}>{tv ? 'Изменить адрес' : 'Подключить'}</button>
    </form>
    {tv && <div className="settings-actions">
      <button type="button" disabled={controlsBusy} onClick={() => start({ action: 'reconnect' })}>Подключиться снова</button>
      <button type="button" disabled={loading} onClick={refresh}>Обновить статус</button>
    </div>}
    {tv && <details className="settings-advanced"><summary>Дополнительно</summary><p>Повторите сопряжение, если телевизор отозвал доступ. Потребуется подтверждение на экране ТВ.</p><button type="button" disabled={controlsBusy} onClick={() => start({ action: 'repair' })}>Повторить сопряжение</button></details>}
  </>;
  const identity = tv && <div className="tv-info"><img className="tv-brand" src="/lg-logo.svg" alt="LG" /><p className="tv-model">{tv.identity.model}</p></div>;
  const ledColor = error || status?.connection === 'authorization_error' || status?.connection === 'compatibility_error' || backgroundDiagnostic ? 'red' : progress || poweringOff ? 'gray' : connectionAppearance === 'available' ? 'green' : 'gray';
  const connectionIndicator = <div className={tv ? 'connection-led' : 'connection-row'} tabIndex={tv ? 0 : undefined} aria-describedby={tv ? 'connection-tooltip' : undefined} data-color={ledColor} data-active={activityBusy && showActivity || undefined} title={tv ? undefined : connectionText}>
    <p className={tv ? 'visually-hidden' : 'connection-status'} data-connection={connectionAppearance} role="status" aria-label="Соединение с телевизором" aria-live="polite">{connectionText}</p>
    <span className="activity-slot">{activityBusy && showActivity && <span className="led-activity" role="img" aria-label="Выполняется запрос" />}</span>
    {tv && <span id="connection-tooltip" role="tooltip" className="connection-tooltip">{connectionText}</span>}
  </div>;
  return <>{identityTarget ? createPortal(identity, identityTarget) : identity}<section className={tv ? 'tv-layout' : 'form-card'}>
    {!tv && status && <h1>Телевизор ещё не настроен</h1>}
    {!tv && !status && !error && showActivity && <p role="status">Загрузка телевизора…</p>}
    {tv && <div className={`connection-progress${settingsOpen ? ' reserved-activity' : ''}`} hidden={!running || powerRunning} aria-hidden={settingsOpen || undefined} inert={settingsOpen}>{running && !powerRunning && activity(!settingsOpen)}</div>}
    {tv && <div className="tv-card">
      <div className="remote-top">{connectionIndicator}</div>
      <PowerControls {...(tvId ? { tvId } : {})} csrfToken={csrfToken} active quietOffline={quietOffline || running} settingsOpen={settingsOpen} settingsTarget={settingsTarget} activityTarget={powerActivityTarget} {...(onConfirmationChange ? { onConfirmationChange } : {})} onSessionExpired={onSessionExpired} onStateChange={observePowerState} onBusyChange={setPowerBusy} />
      <Remote {...(tvId ? { tvId } : {})} csrfToken={csrfToken} active quietOffline={quietRemoteUnavailable} interactionBlocked={settingsOpen} activityTarget={remoteActivityTarget} onSessionExpired={onSessionExpired} onBusyChange={setRemoteBusy} />
    </div>}
    <div className="tv-activity">
      {!tv && (status || error) && <div className={status?.connection === 'unconfigured' ? 'visually-hidden' : undefined}>{connectionIndicator}</div>}
      <div className={settingsOpen ? 'reserved-activity' : undefined} aria-hidden={settingsOpen || undefined} inert={settingsOpen}>{!(tv && running && !powerRunning) && activity(true)}</div>
      <div className="power-activity" ref={setPowerActivityTarget} />
      <div ref={setRemoteActivityTarget} />
    </div>
    {!tv && (status || error) && <>{addressForm}<button type="button" disabled={loading} onClick={refresh}>Обновить статус</button></>}
    <SettingsDialog open={settingsOpen} onClose={onCloseSettings}>
      {tv ? <><section className="settings-section">
        <p className="settings-identity"><span className="settings-model">Модель: {tv.identity.model}</span>{settingsOpen && <span className="tv-version">{tv.identity.platformVersion ? `webOS ${tv.identity.platformVersion}` : 'Версия неизвестна'}</span>}</p>
      </section><section className="settings-section"><h3>Подключение</h3>
        {settingsOpen && activity(false)}<p>Соединение: {connectionText}</p><p>Сохранённый IP: {tv.host}</p>{addressForm}
      </section></> : <>{settingsOpen && activity(false)}<p>Добавьте телевизор на основном экране.</p></>}
      <div ref={setSettingsTarget} />
    </SettingsDialog>
  </section></>;
}
