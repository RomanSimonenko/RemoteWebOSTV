import type { TvCommandRequest, TvCommandResult } from '@remote-webos-tv/contracts';
import type { TvAdapter } from '@remote-webos-tv/tv-adapter';
import { TvButtonSendError, WebOsError } from '@remote-webos-tv/webos';

type RejectionCode = Extract<TvCommandResult, { outcome: 'rejected' }>['error']['code'];
const messages: Record<RejectionCode | 'COMMAND_RESULT_UNKNOWN', string> = {
  TV_UNAVAILABLE: 'Телевизор недоступен. Выполните повторное подключение.',
  TV_BUSY: 'Другая операция с телевизором ещё не завершена.',
  UNSUPPORTED_CAPABILITY: 'Телевизор не поддерживает управление кнопками.',
  COMMAND_NOT_SENT: 'Команда не отправлена.',
  APP_LIST_UNAVAILABLE: 'Не удалось получить список приложений телевизора. Запуск не выполнен.',
  APP_NOT_AVAILABLE: 'Wink не найден среди установленных приложений или найдено несколько вариантов.',
  RATE_LIMITED: 'Слишком много команд. Повторите позже.',
  COMMAND_RESULT_UNKNOWN: 'Результат команды неизвестен. Автоматический повтор не выполняется.',
};

export class TvCommandAdmissionError extends Error {
  constructor(readonly code: 'TV_UNAVAILABLE' | 'TV_BUSY' | 'UNSUPPORTED_CAPABILITY') {
    super(messages[code]); this.name = 'TvCommandAdmissionError';
  }
  get statusCode(): number { return this.code === 'UNSUPPORTED_CAPABILITY' ? 422 : 409; }
}

export function rejectTvCommand(id: string, code: RejectionCode): TvCommandResult {
  return { id, outcome: 'rejected', error: { code, message: messages[code] } };
}

export function unknownTvCommand(id: string): TvCommandResult {
  return { id, outcome: 'unknown', error: { code: 'COMMAND_RESULT_UNKNOWN', message: messages.COMMAND_RESULT_UNKNOWN } };
}

/** Normalization only. Admission, timeout, and lifecycle ownership belong to TV Service. */
export async function executeTvCommand(input: TvCommandRequest, adapter: TvAdapter, signal: AbortSignal): Promise<TvCommandResult> {
  if (signal.aborted) return rejectTvCommand(input.id, 'COMMAND_NOT_SENT');
  try {
    if ('app' in input) {
      if (!adapter.launchApp || !adapter.listApps) return rejectTvCommand(input.id, 'UNSUPPORTED_CAPABILITY');
      let apps;
      try { apps = await adapter.listApps(signal); }
      catch { return rejectTvCommand(input.id, 'APP_LIST_UNAVAILABLE'); }
      if (signal.aborted) return rejectTvCommand(input.id, 'COMMAND_NOT_SENT');
      const matches = apps.filter((app) => app.name.trim().toLowerCase() === 'wink');
      if (matches.length !== 1) return rejectTvCommand(input.id, 'APP_NOT_AVAILABLE');
      await adapter.launchApp(matches[0]!.id, signal);
    } else {
      try { await adapter.prepareRemote(signal); }
      catch (cause) {
        return rejectTvCommand(input.id, cause instanceof WebOsError && (cause.code === 'POINTER_FORBIDDEN' || cause.code === 'UNSUPPORTED_CAPABILITY') ? 'UNSUPPORTED_CAPABILITY' : 'COMMAND_NOT_SENT');
      }
      if (signal.aborted) return rejectTvCommand(input.id, 'COMMAND_NOT_SENT');
      await adapter.sendButton(input.button, signal);
    }
    return signal.aborted ? unknownTvCommand(input.id) : { id: input.id, outcome: 'sent' };
  } catch (cause) {
    if (cause instanceof TvButtonSendError && cause.delivery === 'not_sent') {
      return rejectTvCommand(input.id, cause.code === 'POINTER_FORBIDDEN' || cause.code === 'UNSUPPORTED_CAPABILITY' ? 'UNSUPPORTED_CAPABILITY' : 'COMMAND_NOT_SENT');
    }
    return unknownTvCommand(input.id);
  }
}
