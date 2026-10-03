import type { TvCommandRequest, TvCommandResult } from '@remote-webos-tv/contracts';
import { TvButtonSendError, type WebOsAdapter } from '@remote-webos-tv/webos';

type RejectionCode = Extract<TvCommandResult, { outcome: 'rejected' }>['error']['code'];
const messages: Record<RejectionCode | 'COMMAND_RESULT_UNKNOWN', string> = {
  TV_UNAVAILABLE: 'Телевизор недоступен. Выполните повторное подключение.',
  TV_BUSY: 'Другая операция с телевизором ещё не завершена.',
  UNSUPPORTED_CAPABILITY: 'Телевизор не поддерживает управление кнопками.',
  COMMAND_NOT_SENT: 'Команда не отправлена.',
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
export async function executeTvCommand(input: TvCommandRequest, adapter: WebOsAdapter, signal: AbortSignal): Promise<TvCommandResult> {
  if (signal.aborted) return rejectTvCommand(input.id, 'COMMAND_NOT_SENT');
  try {
    await adapter.sendButton(input.button, signal);
    return signal.aborted ? unknownTvCommand(input.id) : { id: input.id, outcome: 'sent' };
  } catch (cause) {
    if (cause instanceof TvButtonSendError && cause.delivery === 'not_sent') {
      return rejectTvCommand(input.id, cause.code === 'POINTER_FORBIDDEN' || cause.code === 'UNSUPPORTED_CAPABILITY' ? 'UNSUPPORTED_CAPABILITY' : 'COMMAND_NOT_SENT');
    }
    return unknownTvCommand(input.id);
  }
}
