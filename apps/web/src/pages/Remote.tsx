import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BasicTvButton, TvRemoteState, TvCommandResult } from '@remote-webos-tv/contracts';
import { api, ApiFailure } from '../api.js';
import { requestId } from '../requestId.js';

interface Props { csrfToken: string; active: boolean; onSessionExpired(): void; interactionBlocked?: boolean }
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
  ['BACK', 'Назад'], ['HOME', 'Домой'], ['VOLUME_UP', 'Громкость +'], ['VOLUME_DOWN', 'Громкость −'], ['MUTE', 'Без звука'],
];
const keys: Readonly<Record<string, BasicTvButton>> = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Enter: 'ENTER',
  Escape: 'BACK', Home: 'HOME', '+': 'VOLUME_UP', '-': 'VOLUME_DOWN', m: 'MUTE', M: 'MUTE',
};

export function Remote({ csrfToken, active, onSessionExpired, interactionBlocked = false }: Props) {
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
    if (!event.currentTarget.contains(document.activeElement) || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
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
  return <div role="group" aria-label="Пульт" aria-describedby="remote-help" aria-busy={busy} tabIndex={0} className="remote" onKeyDown={keyDown}>
    <h2>Пульт</h2>
    <p id="remote-help">Клавиатура при фокусе на пульте: стрелки, Enter — OK, Escape — назад, Home — домой, +/− — громкость, M — без звука.</p>
    {explanation && <p>{explanation}</p>}
    <div className="remote-buttons">{buttons.map(([button, label]) => <button type="button" key={button} style={{ gridArea: button }} disabled={disabled} onClick={() => void send(button)}>{label}</button>)}</div>
    <p role="status" aria-live="polite">{busy ? 'Отправляем команду…' : feedback && !feedback.alert ? feedback.text : ''}</p>
    {feedback?.alert && <p role="alert" className="error">{feedback.text}</p>}
  </div>;
}
