export type WebOsErrorCode =
  | 'NETWORK_UNREACHABLE'
  | 'PAIRING_REJECTED'
  | 'PAIRING_TIMEOUT'
  | 'AUTHORIZATION_FAILED'
  | 'POINTER_FORBIDDEN'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INVALID_TV_RESPONSE'
  | 'CONNECTION_LOST'
  | 'KEY_STORE_CORRUPT'
  | 'KEY_STORE_WRITE_FAILED'
  | 'UNKNOWN';

const safeMessages: Readonly<Record<WebOsErrorCode, string>> = {
  NETWORK_UNREACHABLE: 'Телевизор недоступен по сети.',
  PAIRING_REJECTED: 'Запрос на сопряжение отклонён.',
  PAIRING_TIMEOUT: 'Время ожидания сопряжения истекло.',
  AUTHORIZATION_FAILED: 'Телевизор не принял сохранённую авторизацию.',
  POINTER_FORBIDDEN: 'Телевизор запретил управление кнопками.',
  UNSUPPORTED_CAPABILITY: 'Эта возможность не поддерживается телевизором.',
  INVALID_TV_RESPONSE: 'Телевизор вернул некорректный ответ.',
  CONNECTION_LOST: 'Соединение с телевизором потеряно.',
  KEY_STORE_CORRUPT: 'Сохранённый ключ сопряжения повреждён.',
  KEY_STORE_WRITE_FAILED: 'Не удалось безопасно сохранить ключ сопряжения.',
  UNKNOWN: 'Произошла неизвестная ошибка управления телевизором.',
};

export interface SafeWebOsDiagnostic {
  readonly code: WebOsErrorCode;
  readonly message: string;
  readonly operationId?: string;
}

export class WebOsError extends Error {
  readonly code: WebOsErrorCode;

  constructor(code: WebOsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebOsError';
    this.code = code;
  }

  toSafeDiagnostic(operationId?: string): SafeWebOsDiagnostic {
    const diagnostic = {
      code: this.code,
      message: safeMessages[this.code],
    };

    return operationId === undefined
      ? diagnostic
      : { ...diagnostic, operationId };
  }
}

/** Transport-owned evidence; consumers must never infer delivery from messages. */
export class TvButtonSendError extends WebOsError {
  constructor(code: WebOsErrorCode, readonly delivery: 'not_sent' | 'unknown', message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = 'TvButtonSendError';
  }
}
