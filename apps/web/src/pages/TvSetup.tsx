import { useEffect, useRef, useState } from 'react';
import { startTvOperationSchema, type StartTvOperation, type TvConnectionState, type TvOperation, type SavedTvView, type TvPowerState } from '@remote-webos-tv/contracts';
import { api, ApiFailure, friendlyError } from '../api.js';
import { useTvStatus } from '../useTvStatus.js';
import { Remote } from './Remote.js';
import { PowerControls } from './PowerControls.js';

interface Props { csrfToken: string; onSessionExpired(): void }
const connections: Record<TvConnectionState, string> = {
  unconfigured: 'Введите IP-адрес телевизора', pairing: 'Сопряжение', connecting: 'Подключение',
  available: 'Подключён', unavailable: 'Нет соединения', reconnecting: 'Подключение',
  authorization_error: 'Ошибка авторизации', compatibility_error: 'Ошибка совместимости',
};

export function TvSetup({ csrfToken, onSessionExpired }: Props) {
  const { status, statusReadVersion, getReadVersion, loading, error, refresh } = useTvStatus(onSessionExpired);
  const [host, setHost] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [powerState, setPowerState] = useState<TvPowerState | null>(null);
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
  useEffect(() => { if (diagnostic) alert.current?.focus(); }, [diagnostic]);

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

  return <section>
    <h1>{tv ? 'Телевизор' : 'Телевизор ещё не настроен'}</h1>
    {tv && <><p>{tv.identity.model}</p><p>{tv.host}</p></>}
    <p role="status" aria-label="Соединение с телевизором" aria-live="polite">{error ? 'Статус неизвестен' : progress || (status ? connections[status.connection] : 'Загрузка статуса…')}</p>
    {diagnostic && <p ref={alert} tabIndex={-1} role="alert" className="error">{diagnostic}</p>}
    {running && !powerRunning && <div>
      {(operation.action === 'pair' || operation.action === 'repair') && <p>Подтвердите доступ на экране телевизора.</p>}
      <p>Осталось: {Math.max(0, Math.ceil((operation.deadlineAt - now) / 1000))} с</p>
      <button type="button" disabled={busy} onClick={() => void mutate((signal) => api.cancelTvOperation(operation.id, csrfToken, signal))}>Отменить</button>
    </div>}
    {status && !running && <>
      {!tv && <p>Телевизор должен быть включён и доступен серверу. Разрешите управление мобильными устройствами в настройках ТВ.</p>}
      <form onSubmit={(event) => { event.preventDefault(); start({ action: tv ? 'change_address' : 'pair', host }); }} noValidate>
        <label>IP-адрес телевизора<input inputMode="decimal" autoComplete="off" value={host} disabled={controlsBusy} onChange={(event) => setHost(event.target.value)} /></label>
        <button type="submit" disabled={controlsBusy}>{tv ? 'Изменить адрес' : 'Подключить'}</button>
      </form>
      {tv && <div>
        <button type="button" disabled={controlsBusy} onClick={() => start({ action: 'reconnect' })}>Подключиться снова</button>
        <button type="button" disabled={controlsBusy} onClick={() => start({ action: 'repair' })}>Повторить сопряжение</button>
      </div>}
    </>}
    <button type="button" disabled={loading} onClick={refresh}>Обновить статус</button>
    {tv && <PowerControls csrfToken={csrfToken} active onSessionExpired={onSessionExpired} onStateChange={setPowerState} />}
    {tv && <Remote csrfToken={csrfToken} active onSessionExpired={onSessionExpired} />}
  </section>;
}
