import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronUp, IconChevronDown, IconChevronLeft, IconChevronRight, IconHome, IconArrowBackUp, IconMinus, IconPlus, IconVolumeOff, type Icon } from '@tabler/icons-react';
import type { BasicTvButton, TvRemoteState, TvCommandResult } from '@remote-webos-tv/contracts';
import { api, ApiFailure } from '../api.js';
import { requestId } from '../requestId.js';

interface Props { csrfToken: string; active: boolean; onSessionExpired(): void; onBusyChange?(busy: boolean): void; interactionBlocked?: boolean; activityTarget?: HTMLElement | null; quietOffline?: boolean }
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
  APP_LIST_UNAVAILABLE: 'Не удалось получить список приложений телевизора. Запуск не выполнен.',
  APP_NOT_AVAILABLE: 'Wink не найден среди установленных приложений или найдено несколько вариантов.',
  RATE_LIMITED: 'Слишком много команд. Попробуйте позже.',
};
const buttons: ReadonlyArray<readonly [BasicTvButton, string]> = [
  ['UP', 'Вверх'], ['LEFT', 'Влево'], ['ENTER', 'OK'], ['RIGHT', 'Вправо'], ['DOWN', 'Вниз'],
  ['HOME', 'Домой'], ['BACK', 'Назад'], ['VOLUME_DOWN', 'Громкость −'], ['MUTE', 'Без звука'], ['VOLUME_UP', 'Громкость +'],
];
const numericButtons: ReadonlyArray<BasicTvButton> = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const repeatable = new Set<BasicTvButton>(['UP', 'DOWN', 'LEFT', 'RIGHT', 'VOLUME_DOWN', 'VOLUME_UP']);
const channelButtons = [['CHANNEL_DOWN', 'Канал −'], ['CHANNEL_UP', 'Канал +']] as const;
const colorButtons = [['RED', 'Красная'], ['GREEN', 'Зелёная'], ['YELLOW', 'Жёлтая'], ['BLUE', 'Синяя']] as const;
const icons: Partial<Record<BasicTvButton, Icon>> = {
  UP: IconChevronUp, DOWN: IconChevronDown, LEFT: IconChevronLeft, RIGHT: IconChevronRight,
  HOME: IconHome, BACK: IconArrowBackUp,
  VOLUME_DOWN: IconMinus, VOLUME_UP: IconPlus, MUTE: IconVolumeOff,
  CHANNEL_DOWN: IconMinus, CHANNEL_UP: IconPlus,
};
const keys: Readonly<Record<string, BasicTvButton>> = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Enter: 'ENTER',
  Escape: 'BACK', Home: 'HOME', '+': 'VOLUME_UP', '-': 'VOLUME_DOWN', m: 'MUTE', M: 'MUTE',
};

export function Remote({ csrfToken, active, onSessionExpired, onBusyChange, interactionBlocked = false, activityTarget, quietOffline = false }: Props) {
  const [state, setState] = useState<TvRemoteState | null>(null);
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; alert: boolean } | null>(null);
  const runtime = useRef<Runtime | null>(null);
  const held = useRef<{ button: BasicTvButton; key?: string; pointerId?: number; timer: ReturnType<typeof setTimeout> | undefined } | null>(null);
  const [heldButton, setHeldButton] = useState<BasicTvButton | null>(null);
  const suppressedClick = useRef<BasicTvButton | null>(null);
  const stopHold = useCallback(() => {
    if (held.current?.timer !== undefined) clearTimeout(held.current.timer);
    held.current = null; setHeldButton(null);
  }, []);
  const sendLatest = useRef(send);
  sendLatest.current = send;
  function beginHold(button: BasicTvButton, owner: { key?: string; pointerId?: number }) {
    if (held.current?.button === button) return;
    stopHold();
    if (interactionBlocked || !active || !state?.enabled || runtime.current?.pending || document.visibilityState === 'hidden') return;
    const hold = { button, ...owner, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    held.current = hold; setHeldButton(button);
    void sendLatest.current(button);
    function tick() {
      if (held.current !== hold) return;
      // Never queue behind an outstanding command; missed ticks are discarded.
      if (!runtime.current?.pending) void sendLatest.current(button);
      if (held.current === hold) hold.timer = setTimeout(tick, 200);
    }
    hold.timer = setTimeout(tick, 400);
  }
  useEffect(() => {
    if (!active || interactionBlocked || !state?.enabled) stopHold();
  }, [active, interactionBlocked, state?.enabled, stopHold]);
  useEffect(() => () => stopHold(), [csrfToken, stopHold]);
  useEffect(() => {
    const releasePointer = (event: PointerEvent) => { if (held.current?.pointerId === event.pointerId) stopHold(); };
    const releaseKey = (event: globalThis.KeyboardEvent) => { if (held.current?.key === event.key) stopHold(); };
    const visibility = () => { if (document.visibilityState !== 'visible') stopHold(); };
    window.addEventListener('pointerup', releasePointer); window.addEventListener('pointercancel', releasePointer);
    window.addEventListener('keyup', releaseKey); window.addEventListener('blur', stopHold);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stopHold(); window.removeEventListener('pointerup', releasePointer); window.removeEventListener('pointercancel', releasePointer);
      window.removeEventListener('keyup', releaseKey); window.removeEventListener('blur', stopHold);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [stopHold]);
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;
  useEffect(() => { onBusyChange?.(active && busy); }, [active, busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    if (!feedback || feedback.alert) return;
    const timer = setTimeout(() => setFeedback((current) => current === feedback ? null : current), 2000);
    return () => clearTimeout(timer);
  }, [feedback]);

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

  async function send(button: BasicTvButton | 'wink') {
    const current = runtime.current;
    if (interactionBlocked || !active || !current?.active || current.pending || !state?.enabled || document.visibilityState === 'hidden') return;
    current.pending = true; current.command = new AbortController();
    setBusy(true); setFeedback(null);
    try {
      let id: string;
      try { id = requestId(); }
      catch {
        stopHold();
        // No API call has started: this failure proves the command was not sent.
        setFeedback({ text: 'Команда не отправлена. Не удалось подготовить идентификатор команды.', alert: true });
        return;
      }
      const result: TvCommandResult = await api.sendCommand(button === 'wink' ? { id, app: 'wink' } : { id, button }, csrfToken, current.command.signal);
      if (!current.active) return;
      if (result.outcome !== 'sent') stopHold();
      setFeedback({ text: result.outcome === 'sent' ? 'Команда отправлена' : result.outcome === 'unknown' ? unknownMessage : rejectionMessages[result.error.code], alert: result.outcome !== 'sent' });
    } catch (cause) {
      if (!current.active) return;
      stopHold();
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
    if (event.ctrlKey || event.altKey || event.metaKey) stopHold();
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(document.activeElement) || target.closest('summary, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if ((event.key === 'Enter' || event.key === ' ') && target.closest('button[data-app]')) { stopHold(); if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) event.preventDefault(); return; }
    const focusedButton = target.closest<HTMLButtonElement>('button[data-command]');
    const spaceButton = event.key === ' ' ? focusedButton?.dataset.command as BasicTvButton | undefined : undefined;
    const button = keys[event.key] ?? (spaceButton && repeatable.has(spaceButton) ? spaceButton : undefined);
    if (!button) return;
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) {
      // Suppress the button's native Enter click as well as the mapped command.
      if ((event.key === 'Enter' || spaceButton) && target.closest('button')) event.preventDefault();
      return;
    }
    if (document.visibilityState === 'hidden') { event.preventDefault(); return; }
    // One owner for Enter, including when a native button has focus.
    event.preventDefault();
    if (repeatable.has(button)) beginHold(button, { key: event.key });
    else { stopHold(); void send(button); }
  }

  if (!active) return null;
  const disabled = interactionBlocked || busy || !state?.enabled;
  const explanation = readError || (state ? state.enabled || (quietOffline && state.reason === 'UNAVAILABLE') ? '' : reasons[state.reason] : 'Проверяем доступность пульта…');
  const controls = (entries: typeof buttons) => entries.map(([button, label]) => {
    const ButtonIcon = icons[button];
    return <button type="button" key={button} data-command={button} aria-label={label} title={label} className={button === 'ENTER' ? 'ok-button' : undefined} style={{ gridArea: button, touchAction: repeatable.has(button) ? 'none' : undefined }} disabled={disabled && heldButton !== button}
      onPointerDown={(event) => {
        if (!repeatable.has(button) || event.button !== 0 || !event.isPrimary) return;
        event.preventDefault(); event.currentTarget.focus(); suppressedClick.current = button;
        beginHold(button, { pointerId: event.pointerId });
      }}
      onPointerLeave={() => { if (held.current?.button === button && held.current.pointerId !== undefined) stopHold(); }}
      onBlur={stopHold}
      onClick={(event) => { if (event.detail > 0 && suppressedClick.current === button) { suppressedClick.current = null; return; } void send(button); }}>
    {ButtonIcon && <ButtonIcon aria-hidden="true" />}
    {button === 'ENTER' && 'OK'}
    {(button === 'CHANNEL_DOWN' || button === 'CHANNEL_UP') && 'CH'}
  </button>;
  });
  const activity = <div className="remote-activity">
    {explanation && <p>{explanation}</p>}
    <p role="status" aria-label="Команды телевизора" aria-live="polite">{!busy && feedback && !feedback.alert ? feedback.text : ''}</p>
    {feedback?.alert && <p role="alert" className="error">{feedback.text}</p>}
  </div>;
  return <><div role="group" aria-label="Пульт" aria-describedby="remote-help" aria-busy={busy} tabIndex={0} className="remote" onKeyDown={keyDown} onBlur={stopHold}>
    <h2 className="visually-hidden">Пульт</h2>
    <div role="group" aria-label="Цифры" className="remote-buttons numeric-pad">{numericButtons.map((button) => <button type="button" key={button} aria-label={button} title={button} disabled={disabled} onClick={() => void send(button)}>{button}</button>)}</div>
    <div role="group" aria-label="Навигация" className="remote-buttons d-pad">{controls(buttons.slice(0, 5))}</div>
    <div role="group" aria-label="Домой и назад" className="remote-buttons home-back">{controls(buttons.slice(5, 7))}</div>
    <div role="group" aria-label="Громкость" className="remote-buttons volume">{controls(buttons.slice(7))}</div>
    <div role="group" aria-label="Каналы" className="remote-buttons channels">{controls(channelButtons)}</div>
    <div role="group" aria-label="Цветные кнопки" className="remote-buttons color-buttons">{colorButtons.map(([button, label]) => <button type="button" key={button} aria-label={label} title={label} data-color={button} disabled={disabled} onClick={() => void send(button)}><span aria-hidden="true" className="color-mark" /></button>)}</div>
    <button type="button" className="wink-button" data-app="wink" aria-label="Запустить Wink" title="Запустить Wink" disabled={disabled} onClick={() => { stopHold(); void send('wink'); }}>
      <img src="/wink-logo.svg" alt="" aria-hidden="true" width="100" height="27" />
    </button>
  </div>{activityTarget ? createPortal(activity, activityTarget) : activity}</>;
}
