import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconInfoCircle, IconPower, IconX } from "@tabler/icons-react";
import type {
  TvPowerOperation,
  TvPowerState,
  TvId,
  TvPlatform,
} from "@remote-webos-tv/contracts";
import { useTvPower } from "../useTvPower.js";

interface Props {
  tvId?: TvId;
  platform?: TvPlatform;
  csrfToken: string;
  active: boolean;
  onSessionExpired(): void;
  onStateChange?(state: TvPowerState | null): void;
  onBusyChange?(busy: boolean): void;
  settingsTarget?: HTMLElement | null;
  activityTarget?: HTMLElement | null;
  settingsOpen?: boolean;
  onConfirmationChange?(confirming: boolean): void;
  quietOffline?: boolean;
}

function progress(
  operation: TvPowerOperation,
  platform: TvPlatform,
): string {
  if (operation.action === "recover") return "";
  if (operation.action === "wake") {
    if (operation.status === "succeeded") return "";
    if (operation.delivery === "sent") return "";
    if (operation.delivery === "unknown")
      return "Результат отправки неизвестен. Ожидаем обновления статуса";
    return "";
  }
  if (operation.status === "succeeded") {
    if (platform === "tizen") return "";
    return "Команда выключения отправлена. Соединение с телевизором потеряно; фактическое выключение не подтверждено.";
  }
  if (operation.delivery === "sent") return "";
  if (operation.delivery === "unknown")
    return "Выключение не подтверждено. Результат отправки неизвестен";
  return "";
}

function terminalError(
  operation: TvPowerOperation | null | undefined,
  platform: TvPlatform,
): string {
  if (
    !operation ||
    operation.status === "running" ||
    operation.status === "succeeded"
  )
    return "";
  if (operation.action === "wake" && operation.delivery === "not_sent" &&
    ["NETWORK_UNREACHABLE", "CONNECTION_LOST", "TV_UNAVAILABLE", "UNKNOWN"].includes(operation.error?.code ?? ""))
    return "Не удалось отправить запрос включения. Проверьте сетевое подключение приложения.";
  const messages: Readonly<Record<string, string>> = {
    ...(platform === "tizen"
      ? {
          NETWORK_UNREACHABLE:
            "Не удалось установить соединение управления с телевизором.",
        }
      : {}),
    RECOVERY_TIMEOUT:
      operation.action === "wake"
        ? "Телевизор не ответил за отведённое время. Проверьте питание ТВ и настройки включения по сети."
        : "Не удалось подключиться к телевизору за отведённое время. Проверьте, что телевизор включён и доступен по сети.",
    AUTHORIZATION_FAILED:
      "Телевизор отклонил сохранённый ключ. Повторите сопряжение.",
    INVALID_TV_RESPONSE:
      "Ошибка совместимости с телевизором. Проверьте его поддержку.",
    UNSUPPORTED_CAPABILITY: "Телевизор не поддерживает эту команду.",
    POWER_OFF_UNCONFIRMED:
      "Не удалось подтвердить выключение. Проверьте телевизор",
    CANCELLED: "Операция отменена. Уже отправленный сигнал отменить нельзя.",
  };
  const detail =
    messages[operation.error?.code ?? ""] ||
    operation.error?.message ||
    "Операция не завершена.";
  return operation.delivery === "unknown"
    ? `Результат отправки неизвестен. ${detail}`
    : detail;
}

export function PowerControls({
  tvId,
  platform = "webos",
  csrfToken,
  active,
  onSessionExpired,
  onStateChange,
  onBusyChange,
  settingsTarget,
  activityTarget,
  settingsOpen = false,
  onConfirmationChange,
  quietOffline = false,
}: Props) {
  const networkHelpId = useId();
  const {
    state,
    loading,
    error,
    message,
    busy,
    refresh,
    start,
    saveMac,
    cancel,
  } = useTvPower(active, csrfToken, onSessionExpired, tvId);
  const [mac, setMac] = useState("");
  const [confirming, setConfirming] = useState(false);
  const alert = useRef<HTMLParagraphElement>(null);
  const confirmation = useRef<HTMLButtonElement>(null);
  const powerButton = useRef<HTMLButtonElement>(null);
  const confirmationPanel = useRef<HTMLDivElement>(null);
  function dismissConfirmation() {
    setConfirming(false);
    powerButton.current?.focus();
  }
  useEffect(() => {
    if (!confirming) return;
    function outside(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        !confirmationPanel.current?.contains(event.target) &&
        !powerButton.current?.contains(event.target)
      )
        dismissConfirmation();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismissConfirmation();
    }
    document.addEventListener("click", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [confirming]);
  const operation = state?.operation;
  const running = operation?.status === "running";
  const [expiredShutdownWarning, setExpiredShutdownWarning] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (
      !active ||
      operation?.status !== "failed" ||
      operation.delivery !== "sent" ||
      operation.error?.code !== "POWER_OFF_UNCONFIRMED"
    )
      return;
    const timer = setTimeout(
      () => setExpiredShutdownWarning(operation.id),
      5000,
    );
    return () => clearTimeout(timer);
  }, [
    active,
    operation?.id,
    operation?.status,
    operation?.delivery,
    operation?.error?.code,
  ]);
  const activityBusy = active && (busy || loading || !!state?.busy || running);
  useEffect(() => {
    onBusyChange?.(activityBusy);
  }, [activityBusy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const conflicting = !!state?.canPowerOff && state.canWake;
  const samsung = platform === "tizen";
  const powerAction = conflicting
    ? null
    : state?.canPowerOff && (!samsung || state.observedPower === "on")
      ? "power_off"
      : state?.canWake && (samsung ? state.observedPower === "standby" : state.mac)
        ? "wake"
        : null;
  const disabled = busy || loading || !!error || !state || running;
  const powerDisabled =
    settingsOpen ||
    busy ||
    loading ||
    !!error ||
    !state ||
    !powerAction ||
    (running && !(powerAction === "wake" && operation?.action === "recover"));
  const diagnostic =
    message ||
    error ||
    (conflicting
      ? "Сервер вернул противоречивые разрешения питания. Обновите статус."
      : terminalError(operation, platform));
  const backgroundDiagnostic =
    !message &&
    !error &&
    !conflicting &&
    operation?.delivery === "sent" &&
    operation.error?.code === "POWER_OFF_UNCONFIRMED" &&
    operation.id === expiredShutdownWarning
      ? ""
      : diagnostic;
  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);
  useEffect(() => {
    if (state) setMac(state.mac ?? "");
  }, [state?.mac, settingsOpen]);
  useEffect(() => {
    onConfirmationChange?.(confirming);
  }, [confirming, onConfirmationChange]);
  useEffect(() => () => onConfirmationChange?.(false), [onConfirmationChange]);
  useEffect(() => {
    if (!active || powerAction !== "power_off" || powerDisabled)
      setConfirming(false);
  }, [active, powerAction, powerDisabled]);
  useEffect(() => {
    if (confirming) confirmation.current?.focus();
  }, [confirming]);
  // Modal transitions do not refocus an existing background diagnostic.
  useEffect(() => {
    if (backgroundDiagnostic && !settingsOpen)
      alert.current?.focus({ preventScroll: true });
  }, [backgroundDiagnostic]);

  if (!active) return null;
  const networkPowerUnsupported = state?.wakeSupported === false;
  const unknownSamsungPower =
    samsung &&
    !!state &&
    state.observedPower !== "on" &&
    state.observedPower !== "standby";
  const unavailable = samsung
    ? state?.observedPower === "standby"
      ? "Питание сейчас недоступно. Обновите статус."
      : state?.observedPower === "on"
        ? "Питание сейчас недоступно. Обновите статус."
        : "Статус питания неизвестен"
    : networkPowerUnsupported
      ? "Включение по сети для этого телевизора пока недоступно в приложении."
      : !state?.mac
        ? "Для включения сохраните MAC-адрес телевизора в настройках."
        : "Питание сейчас недоступно. Обновите статус.";
  // Only the retained background diagnostic owns autofocus; modal teardown
  // must not clear its ref while the background paragraph remains mounted.
  const activity = (withFocusRef: boolean) => (
    <>
      <p role="status" aria-label="Питание телевизора" aria-live="polite">
        {error || (unknownSamsungPower && !activityBusy)
          ? "Статус питания неизвестен"
          : operation && (running || operation.status === "succeeded")
            ? progress(operation, platform)
            : !activityBusy && !powerAction && !diagnostic
              ? unavailable
              : ""}
      </p>
      {(withFocusRef ? backgroundDiagnostic : diagnostic) && (
        <p
          ref={withFocusRef ? alert : undefined}
          tabIndex={-1}
          role="alert"
          className="error"
        >
          {withFocusRef ? backgroundDiagnostic : diagnostic}
        </p>
      )}
      {running && (
        <div>
          {operation.action !== "recover" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => cancel(operation.id)}
            >
              Отменить ожидание
            </button>
          )}
        </div>
      )}
    </>
  );
  const settings = samsung ? null : networkPowerUnsupported ? (
    <section className="settings-section">
      <h3>Включение по сети</h3>
      {settingsOpen ? activity(false) : <p>{unavailable}</p>}
    </section>
  ) : (
    <section className="settings-section">
      <div className="settings-network-heading">
        <h3>Включение по сети</h3>
        <button
          className="settings-help"
          type="button"
          aria-label="О включении по сети"
          aria-describedby={networkHelpId}
        >
          <IconInfoCircle aria-hidden="true" />
        </button>
        <div className="settings-tooltip" id={networkHelpId} role="tooltip">
          <p>
            Для включения нужен MAC-адрес телевизора. После изменения IP
            проверьте, что MAC принадлежит этому телевизору.
          </p>
          <p>
            Отправка сигнала не гарантирует включение. Сервер должен находиться
            в сети телевизора; WOL зависит от модели и настроек питания.
          </p>
        </div>
      </div>
      {settingsOpen && activity(false)}
      <form
        className="settings-edit-row"
        onSubmit={(event) => {
          event.preventDefault();
          saveMac(mac.trim() || null);
        }}
        noValidate
      >
        <label>
          MAC-адрес телевизора
          <input
            autoComplete="off"
            value={mac}
            disabled={disabled}
            onChange={(event) => setMac(event.target.value)}
          />
        </label>
        <button className="settings-primary" type="submit" disabled={disabled}>
          Сохранить MAC
        </button>
      </form>
      <div className="settings-actions">
        <button
          type="button"
          disabled={disabled || !state?.mac}
          onClick={() => saveMac(null)}
        >
          Очистить MAC
        </button>
        <button type="button" disabled={loading} onClick={refresh}>
          Обновить статус питания
        </button>
      </div>
    </section>
  );
  const quietRecovery =
    quietOffline &&
    !(samsung && state?.observedPower === "standby") &&
    !unknownSamsungPower &&
    !message &&
    !error &&
    !conflicting &&
    (!operation ||
      (operation.action === "recover" &&
        (!operation.error ||
          ["RECOVERY_TIMEOUT", "CONNECTION_LOST", "TV_UNAVAILABLE"].includes(
            operation.error.code,
          ))));
  const backgroundActivity = (
    <div
      className={settingsOpen ? "reserved-activity" : undefined}
      aria-hidden={settingsOpen || undefined}
      inert={settingsOpen}
    >
      {!quietRecovery && !(activityTarget && running) && activity(true)}
    </div>
  );
  const powerConfirmation = confirming && (
    <div
      ref={confirmationPanel}
      className="power-confirmation"
      role="dialog"
      aria-label="Выключить телевизор?"
    >
      <div className="power-confirm-heading">
        <IconPower aria-hidden="true" />
        <h3>Выключить ТВ?</h3>
        <button
          className="power-confirm-close"
          type="button"
          aria-label="Закрыть подтверждение"
          onClick={dismissConfirmation}
        >
          <IconX aria-hidden="true" />
        </button>
      </div>
      <div className="power-confirm-actions">
        <button ref={confirmation} type="button" onClick={dismissConfirmation}>
          Отмена
        </button>
        <button
          className="power-confirm-submit"
          type="button"
          disabled={powerDisabled}
          onClick={() => {
            setConfirming(false);
            start("power_off");
          }}
        >
          Выключить
        </button>
      </div>
      {!samsung && (
        <details className="power-confirm-details">
          <summary>
            <IconInfoCircle aria-hidden="true" />О статусе питания
          </summary>
          <p>
            Потеря соединения не подтверждает фактическое выключение телевизора.
          </p>
        </details>
      )}
    </div>
  );
  return (
    <div
      className="power-controls"
      role="group"
      aria-label="Питание телевизора"
      aria-busy={busy}
    >
      <h2 className="visually-hidden">Питание телевизора</h2>
      {activityTarget
        ? createPortal(backgroundActivity, activityTarget)
        : backgroundActivity}
      <button
        className="power-button"
        ref={powerButton}
        type="button"
        aria-label={
          powerAction === "power_off"
            ? "Выключить ТВ"
            : powerAction === "wake"
              ? "Включить ТВ"
              : "Питание ТВ"
        }
        title={
          powerAction === "power_off"
            ? "Выключить ТВ"
            : powerAction === "wake"
              ? "Включить ТВ"
              : "Питание ТВ"
        }
        disabled={powerDisabled}
        onClick={() => {
          if (powerDisabled) return;
          if (powerAction === "power_off") setConfirming(true);
          else if (powerAction === "wake") start("wake");
        }}
      >
        <IconPower aria-hidden="true" />
      </button>
      {powerConfirmation}
      {settingsTarget ? createPortal(settings, settingsTarget) : settings}
    </div>
  );
}
