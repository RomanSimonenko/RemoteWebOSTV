import { useEffect, useRef, useState } from 'react';
import type { TvPowerOperation, TvPowerState } from '@remote-webos-tv/contracts';
import { useTvPower } from '../useTvPower.js';

interface Props { csrfToken: string; active: boolean; onSessionExpired(): void; onStateChange?(state: TvPowerState | null): void }

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

export function PowerControls({ csrfToken, active, onSessionExpired, onStateChange }: Props) {
  const { state, loading, error, message, busy, refresh, start, saveMac, cancel } = useTvPower(active, csrfToken, onSessionExpired);
  const [mac, setMac] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(Date.now);
  const alert = useRef<HTMLParagraphElement>(null);
  const confirmation = useRef<HTMLButtonElement>(null);
  const offButton = useRef<HTMLButtonElement>(null);
  const operation = state?.operation;
  const running = operation?.status === 'running';
  const diagnostic = message || error || terminalError(operation);
  useEffect(() => { onStateChange?.(state); }, [state, onStateChange]);
  useEffect(() => { if (state) setMac(state.mac ?? ''); }, [state?.mac]);
  useEffect(() => { if (!active || !state?.canPowerOff || busy) setConfirming(false); }, [active, state?.canPowerOff, busy]);
  useEffect(() => { if (confirming) confirmation.current?.focus(); }, [confirming]);
  useEffect(() => { if (diagnostic) alert.current?.focus(); }, [diagnostic]);
  useEffect(() => {
    if (!active || !running) return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, running, operation?.id]);

  if (!active) return null;
  const disabled = busy || !state || running;
  return <div role="group" aria-label="Питание телевизора" aria-busy={busy}>
    <h2>Питание телевизора</h2>
    <p role="status" aria-label="Питание телевизора" aria-live="polite">{error ? 'Статус питания неизвестен' : loading ? 'Загрузка статуса питания…' : operation && (running || operation.status === 'succeeded') ? progress(operation) : busy ? 'Выполняется запрос…' : ''}</p>
    {diagnostic && <p ref={alert} tabIndex={-1} role="alert" className="error">{diagnostic}</p>}
    <button ref={offButton} type="button" disabled={disabled || !state?.canPowerOff} onClick={() => setConfirming(true)}>Выключить ТВ</button>
    <button type="button" disabled={disabled || !state?.canWake || !state.mac} onClick={() => start('wake')}>Включить ТВ</button>
    {confirming && <div role="dialog" aria-label="Выключить телевизор?" aria-describedby="power-confirm-help">
      <p id="power-confirm-help">Выключить телевизор? Потеря соединения не подтверждает фактическое выключение.</p>
      <button ref={confirmation} type="button" disabled={busy} onClick={() => { setConfirming(false); start('power_off'); }}>Подтвердить выключение</button>
      <button type="button" onClick={() => { setConfirming(false); offButton.current?.focus(); }}>Не выключать</button>
    </div>}
    {running && <div>
      <p>Осталось: {Math.max(0, Math.ceil((operation.deadlineAt - now) / 1000))} с</p>
      {operation.action !== 'recover' && <button type="button" disabled={busy} onClick={() => cancel(operation.id)}>Отменить ожидание</button>}
    </div>}
    <form onSubmit={(event) => { event.preventDefault(); saveMac(mac.trim() || null); }} noValidate>
      <label>MAC-адрес телевизора<input autoComplete="off" value={mac} disabled={disabled} onChange={(event) => setMac(event.target.value)} /></label>
      <button type="submit" disabled={disabled}>Сохранить MAC</button>
      <button type="button" disabled={disabled || !state?.mac} onClick={() => saveMac(null)}>Очистить MAC</button>
    </form>
    <p>Для включения нужен MAC-адрес телевизора. После изменения IP проверьте, что MAC принадлежит этому телевизору.</p>
    <p>Отправка сигнала не гарантирует включение. Сервер должен находиться в сети телевизора; WOL зависит от модели и настроек питания.</p>
    <button type="button" disabled={loading} onClick={refresh}>Обновить статус питания</button>
  </div>;
}
