import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconPower } from '@tabler/icons-react';
import type { TvPowerOperation, TvPowerState } from '@remote-webos-tv/contracts';
import { useTvPower } from '../useTvPower.js';

interface Props { csrfToken: string; active: boolean; onSessionExpired(): void; onStateChange?(state: TvPowerState | null): void; settingsTarget?: HTMLElement | null; activityTarget?: HTMLElement | null; settingsOpen?: boolean; onConfirmationChange?(confirming: boolean): void }

function progress(operation: TvPowerOperation): string {
  if (operation.action === 'recover') return operation.status === 'succeeded' ? 'Соединение с телевизором восстановлено' : 'Восстанавливаем соединение с телевизором';
  if (operation.action === 'wake') {
    if (operation.status === 'succeeded') return 'Соединение с телевизором восстановлено';
    if (operation.delivery === 'sent') return 'Сигнал включения отправлен. Ожидаем телевизор';
    if (operation.delivery === 'unknown') return 'Результат отправки неизвестен. Ожидаем обновления статуса';
    return 'Отправляем сигнал включения…';
  }
  if (operation.status === 'succeeded') return 'Команда выключения отправлена. Соединение с телевизором потеряно; фактическое выключение не подтверждено.';
  if (operation.delivery === 'sent') return 'Команда выключения отправлена. Ожидаем потерю соединения';
  if (operation.delivery === 'unknown') return 'Выключение не подтверждено. Результат отправки неизвестен';
  return 'Отправляем команду выключения…';
}

function terminalError(operation: TvPowerOperation | null | undefined): string {
  if (!operation || operation.status === 'running' || operation.status === 'succeeded') return '';
  const messages: Readonly<Record<string, string>> = {
    RECOVERY_TIMEOUT: 'Не удалось подключиться к телевизору. Подключитесь снова вручную.',
    AUTHORIZATION_FAILED: 'Телевизор отклонил сохранённый ключ. Повторите сопряжение.',
    INVALID_TV_RESPONSE: 'Ошибка совместимости с телевизором. Проверьте его поддержку.',
    UNSUPPORTED_CAPABILITY: 'Телевизор не поддерживает эту команду.',
    POWER_OFF_UNCONFIRMED: 'Выключение не подтверждено. Проверьте телевизор перед повтором.',
    CANCELLED: 'Операция отменена. Уже отправленный сигнал отменить нельзя.',
  };
  const detail = messages[operation.error?.code ?? ''] || operation.error?.message || 'Операция не завершена.';
  return operation.delivery === 'unknown' ? `Результат отправки неизвестен. ${detail}` : detail;
}

export function PowerControls({ csrfToken, active, onSessionExpired, onStateChange, settingsTarget, activityTarget, settingsOpen = false, onConfirmationChange }: Props) {
  const { state, loading, error, message, busy, refresh, start, saveMac, cancel } = useTvPower(active, csrfToken, onSessionExpired);
  const [mac, setMac] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(Date.now);
  const alert = useRef<HTMLParagraphElement>(null);
  const confirmation = useRef<HTMLButtonElement>(null);
  const powerButton = useRef<HTMLButtonElement>(null);
  const operation = state?.operation;
  const running = operation?.status === 'running';
  const conflicting = !!state?.canPowerOff && state.canWake;
  const powerAction = conflicting ? null : state?.canPowerOff ? 'power_off' : state?.canWake && state.mac ? 'wake' : null;
  const disabled = busy || loading || !!error || !state || running;
  const powerDisabled = settingsOpen || disabled || !powerAction;
  const diagnostic = message || error || (conflicting ? 'Сервер вернул противоречивые разрешения питания. Обновите статус.' : terminalError(operation));
  useEffect(() => { onStateChange?.(state); }, [state, onStateChange]);
  useEffect(() => { if (state) setMac(state.mac ?? ''); }, [state?.mac, settingsOpen]);
  useEffect(() => { onConfirmationChange?.(confirming); }, [confirming, onConfirmationChange]);
  useEffect(() => () => onConfirmationChange?.(false), [onConfirmationChange]);
  useEffect(() => { if (!active || powerAction !== 'power_off' || powerDisabled) setConfirming(false); }, [active, powerAction, powerDisabled]);
  useEffect(() => { if (confirming) confirmation.current?.focus(); }, [confirming]);
  // Modal transitions do not refocus an existing background diagnostic.
  useEffect(() => { if (diagnostic && !settingsOpen) alert.current?.focus(); }, [diagnostic]);
  useEffect(() => {
    if (!active || !running) return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, running, operation?.id]);

  if (!active) return null;
  const unavailable = !state?.mac ? 'Для включения сохраните MAC-адрес телевизора в настройках.' : 'Питание сейчас недоступно. Обновите статус.';
  // Only the retained background diagnostic owns autofocus; modal teardown
  // must not clear its ref while the background paragraph remains mounted.
  const activity = (withFocusRef: boolean) => <>
    <p role="status" aria-label="Питание телевизора" aria-live="polite">{error ? 'Статус питания неизвестен' : loading ? 'Загрузка статуса питания…' : operation && (running || operation.status === 'succeeded') ? progress(operation) : busy ? 'Выполняется запрос…' : !powerAction && !diagnostic ? unavailable : ''}</p>
    {diagnostic && <p ref={withFocusRef ? alert : undefined} tabIndex={-1} role="alert" className="error">{diagnostic}</p>}
    {running && <div>
      <p>Осталось: {Math.max(0, Math.ceil((operation.deadlineAt - now) / 1000))} с</p>
      {operation.action !== 'recover' && <button type="button" disabled={busy} onClick={() => cancel(operation.id)}>Отменить ожидание</button>}
    </div>}
  </>;
  const settings = <>
    {settingsOpen && activity(false)}
    <form onSubmit={(event) => { event.preventDefault(); saveMac(mac.trim() || null); }} noValidate>
      <label>MAC-адрес телевизора<input autoComplete="off" value={mac} disabled={disabled} onChange={(event) => setMac(event.target.value)} /></label>
      <button type="submit" disabled={disabled}>Сохранить MAC</button>
      <button type="button" disabled={disabled || !state?.mac} onClick={() => saveMac(null)}>Очистить MAC</button>
    </form>
    <p>Для включения нужен MAC-адрес телевизора. После изменения IP проверьте, что MAC принадлежит этому телевизору.</p>
    <p>Отправка сигнала не гарантирует включение. Сервер должен находиться в сети телевизора; WOL зависит от модели и настроек питания.</p>
    <button type="button" disabled={loading} onClick={refresh}>Обновить статус питания</button>
  </>;
  const backgroundActivity = <div className={settingsOpen ? 'reserved-activity' : undefined} aria-hidden={settingsOpen || undefined} inert={settingsOpen}>{activity(true)}</div>;
  const powerConfirmation = confirming && <div className="power-confirmation" role="dialog" aria-label="Выключить телевизор?" aria-describedby="power-confirm-help">
    <p id="power-confirm-help">Выключить телевизор? Потеря соединения не подтверждает фактическое выключение.</p>
    <button ref={confirmation} type="button" disabled={powerDisabled} onClick={() => { setConfirming(false); start('power_off'); }}>Подтвердить выключение</button>
    <button type="button" onClick={() => { setConfirming(false); powerButton.current?.focus(); }}>Не выключать</button>
  </div>;
  return <div className="power-controls" role="group" aria-label="Питание телевизора" aria-busy={busy}>
    <h2 className="visually-hidden">Питание телевизора</h2>
    {activityTarget ? createPortal(backgroundActivity, activityTarget) : backgroundActivity}
    <button className="power-button" ref={powerButton} type="button" aria-label={powerAction === 'power_off' ? 'Выключить ТВ' : powerAction === 'wake' ? 'Включить ТВ' : 'Питание ТВ'} title={powerAction === 'power_off' ? 'Выключить ТВ' : powerAction === 'wake' ? 'Включить ТВ' : 'Питание ТВ'} disabled={powerDisabled} onClick={() => { if (powerDisabled) return; if (powerAction === 'power_off') setConfirming(true); else if (powerAction === 'wake') start('wake'); }}><IconPower aria-hidden="true" /></button>
    {activityTarget ? createPortal(powerConfirmation, activityTarget) : powerConfirmation}
    {settingsTarget ? createPortal(settings, settingsTarget) : settings}
  </div>;
}
