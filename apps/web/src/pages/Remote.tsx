import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BasicTvButton, TvRemoteState, TvCommandResult } from '@remote-webos-tv/contracts';
import { api, ApiFailure } from '../api.js';
import { requestId } from '../requestId.js';

interface Props { csrfToken: string; active: boolean; onSessionExpired(): void; interactionBlocked?: boolean; activityTarget?: HTMLElement | null }
interface Runtime { active: boolean; pending: boolean; command: AbortController | null; refresh(): void }
const unknownMessage = 'Результат команды неизвестен. Автоматический повтор не выполняется';
const reasons = {
  UNAVAILABLE: 'Телевизор недоступен. Подключитесь снова.',
  BUSY: 'Телевизор занят. Дождитесь завершения операции.',
  UNSUPPORTED: 'Управление кнопками не поддерживается телевизором.',
};
const rejectionMessages = {
  TV_UNAVAILABLE: reasons.UNAVAILABLE,
  TV_BUSY: reasons.BUSY,
  UNSUPPORTED_CAPABILITY: reasons.UNSUPPORTED,
  COMMAND_NOT_SENT: 'Команда не отправлена. Попробуйте снова.',
  RATE_LIMITED: 'Слишком много команд. Попробуйте позже.',
};
const buttons: ReadonlyArray<readonly [BasicTvButton, string]> = [
  ['UP', 'Вверх'], ['LEFT', 'Влево'], ['ENTER', 'OK'], ['RIGHT', 'Вправо'], ['DOWN', 'Вниз'],
  ['HOME', 'Домой'], ['BACK', 'Назад'], ['VOLUME_DOWN', 'Громкость −'], ['MUTE', 'Без звука'], ['VOLUME_UP', 'Громкость +'],
];
const iconPaths: Partial<Record<BasicTvButton, string>> = {
  UP: 'm6 15 6-6 6 6', DOWN: 'm6 9 6 6 6-6', LEFT: 'm15 6-6 6 6 6', RIGHT: 'm9 6 6 6-6 6',
  HOME: 'm3 11 9-8 9 8M6 9v12h12V9', BACK: 'm9 5-6 6 6 6M3 11h11a6 6 0 0 1 0 12',
  VOLUME_DOWN: 'M3 10h4l5-4v12l-5-4H3zM16 12h6', VOLUME_UP: 'M3 10h4l5-4v12l-5-4H3zM16 12h6M19 9v6',
  MUTE: 'M3 10h4l5-4v12l-5-4H3zM17 9l5 6M22 9l-5 6',
};
const keys: Readonly<Record<string, BasicTvButton>> = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Enter: 'ENTER',
  Escape: 'BACK', Home: 'HOME', '+': 'VOLUME_UP', '-': 'VOLUME_DOWN', m: 'MUTE', M: 'MUTE',
};

export function Remote({ csrfToken, active, onSessionExpired, interactionBlocked = false, activityTarget }: Props) {
  const [state, setState] = useState<TvRemoteState | null>(null);
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; alert: boolean } | null>(null);
  const runtime = useRef<Runtime | null>(null);
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;

  useEffect(() => {
    setState(null); setReadError(''); setFeedback(null); setBusy(false);
    if (!active) return;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let readController: AbortController | undefined;
    const current: Runtime = { active: true, pending: false, command: null, refresh: schedule };
    runtime.current = current;
    // Same completion-based cooldown as useTvStatus: refresh never bypasses
    // the interval or overlaps a capability read already in progress.
    function schedule() {
      if (current.active && !inFlight && timer === undefined) timer = setTimeout(() => { timer = undefined; void read(); }, 2000);
    }
    async function read() {
      if (!current.active || inFlight) return;
      inFlight = true;
      readController = new AbortController();
      try {
        const next = await api.remoteState(readController.signal);
        if (!current.active) return;
        setState(next); setReadError('');
      } catch (cause) {
        if (!current.active) return;
        setState(null);
        if (cause instanceof ApiFailure && cause.status === 401) {
          current.active = false; current.command?.abort(); expired.current();
        } else setReadError('Не удалось проверить доступность пульта. Ожидаем обновления статуса.');
      } finally { inFlight = false; schedule(); }
    }
    void read();
    return () => {
      current.active = false;
      if (timer !== undefined) clearTimeout(timer);
      readController?.abort(); current.command?.abort();
      if (runtime.current === current) runtime.current = null;
    };
  }, [active, csrfToken]);

  async function send(button: BasicTvButton) {
    const current = runtime.current;
    if (interactionBlocked || !active || !current?.active || current.pending || !state?.enabled || document.visibilityState === 'hidden') return;
    current.pending = true; current.command = new AbortController();
    setBusy(true); setFeedback(null);
    try {
      let id: string;
      try { id = requestId(); }
      catch {
        // No API call has started: this failure proves the command was not sent.
        setFeedback({ text: 'Команда не отправлена. Не удалось подготовить идентификатор команды.', alert: true });
        return;
      }
      const result: TvCommandResult = await api.sendCommand({ id, button }, csrfToken, current.command.signal);
      if (!current.active) return;
      setFeedback({ text: result.outcome === 'sent' ? 'Команда отправлена' : result.outcome === 'unknown' ? unknownMessage : rejectionMessages[result.error.code], alert: result.outcome !== 'sent' });
    } catch (cause) {
      if (!current.active) return;
      if (cause instanceof ApiFailure && cause.status === 401) {
        current.active = false; setState(null); expired.current();
      } else {
        // Auth/schema rejection is before dispatch. All lost or malformed
        // command responses remain uncertain; no automatic POST retry.
        const rejected = cause instanceof ApiFailure && cause.commandRejectedBeforeDispatch;
        setFeedback({ text: rejected ? 'Команда отклонена. Проверьте сессию и попробуйте снова.' : unknownMessage, alert: true });
      }
    } finally {
      current.pending = false;
      if (current.active) { setBusy(false); current.refresh(); }
    }
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (interactionBlocked) return;
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(document.activeElement) || target.closest('summary, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const button = keys[event.key];
    if (!button) return;
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) {
      // Suppress the button's native Enter click as well as the mapped command.
      if (event.key === 'Enter' && target.closest('button')) event.preventDefault();
      return;
    }
    if (document.visibilityState === 'hidden') { event.preventDefault(); return; }
    // One owner for Enter, including when a native button has focus.
    event.preventDefault(); void send(button);
  }

  if (!active) return null;
  const disabled = interactionBlocked || busy || !state?.enabled;
  const explanation = readError || (state ? state.enabled ? '' : reasons[state.reason] : 'Проверяем доступность пульта…');
  const controls = (entries: typeof buttons) => entries.map(([button, label]) => <button type="button" key={button} aria-label={label} title={label} className={button === 'ENTER' ? 'ok-button' : undefined} style={{ gridArea: button }} disabled={disabled} onClick={() => void send(button)}>
    {iconPaths[button] && <svg aria-hidden="true" viewBox="0 0 24 24"><path d={iconPaths[button]} /></svg>}
    {button === 'ENTER' && 'OK'}
  </button>);
  const activity = <div className="remote-activity">
    {explanation && <p>{explanation}</p>}
    <p role="status" aria-label="Команды телевизора" aria-live="polite">{busy ? 'Отправляем команду…' : feedback && !feedback.alert ? feedback.text : ''}</p>
    {feedback?.alert && <p role="alert" className="error">{feedback.text}</p>}
  </div>;
  return <><div role="group" aria-label="Пульт" aria-describedby="remote-help" aria-busy={busy} tabIndex={0} className="remote" onKeyDown={keyDown}>
    <h2 className="visually-hidden">Пульт</h2>
    <div role="group" aria-label="Навигация" className="remote-buttons d-pad">{controls(buttons.slice(0, 5))}</div>
    <div role="group" aria-label="Домой и назад" className="remote-buttons home-back">{controls(buttons.slice(5, 7))}</div>
    <div role="group" aria-label="Громкость" className="remote-buttons volume">{controls(buttons.slice(7))}</div>
  </div>{activityTarget ? createPortal(activity, activityTarget) : activity}</>;
}
