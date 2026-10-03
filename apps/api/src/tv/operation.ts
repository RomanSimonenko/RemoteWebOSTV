import type { TvConnectionState, TvStatusResponse } from '@remote-webos-tv/contracts';
import { WebOsError } from '@remote-webos-tv/webos';

export type PublicTvError = NonNullable<TvStatusResponse['error']>;
const messages = {
  OPERATION_CONFLICT: 'Другая операция с телевизором ещё не завершена.',
  INVALID_ACTION: 'Это действие недоступно для текущей настройки телевизора.',
  INVALID_REQUEST: 'Некорректный запрос настройки телевизора.',
  OPERATION_NOT_FOUND: 'Операция с телевизором не найдена.',
  SERVICE_CLOSED: 'Сервис телевизора остановлен.',
  CANCELLED: 'Операция отменена.',
  CLEANUP_FAILED: 'Не удалось завершить очистку соединения с телевизором.',
  STORAGE_FAILED: 'Не удалось сохранить настройку телевизора.',
  TV_OPERATION_FAILED: 'Не удалось завершить операцию с телевизором.',
} as const;
export type TvServiceErrorCode = keyof typeof messages;

export class TvServiceError extends Error {
  constructor(readonly code: TvServiceErrorCode, readonly statusCode: number = 500, options?: ErrorOptions) {
    super(messages[code], options); this.name = 'TvServiceError';
  }
}

function hasCleanupFailure(cause: unknown): boolean {
  const visited = new Set<Error>();
  // Error causes come from external boundaries: neither cycles nor extreme depth
  // may turn safe diagnostic projection into another operation failure.
  for (let depth = 0; depth < 64 && cause instanceof Error; depth++) {
    if (visited.has(cause)) return false;
    visited.add(cause);
    if (cause instanceof TvServiceError && cause.code === 'CLEANUP_FAILED') return true;
    if (cause instanceof AggregateError) return true;
    cause = cause.cause;
  }
  return false;
}

/** The only browser error projection: raw messages and nested causes never cross it. */
export function projectTvError(cause: unknown): PublicTvError {
  let error: PublicTvError;
  if (cause instanceof WebOsError) error = cause.toSafeDiagnostic();
  else if (cause instanceof TvServiceError) error = { code: cause.code, message: messages[cause.code] };
  else error = { code: 'TV_OPERATION_FAILED', message: messages.TV_OPERATION_FAILED };
  return hasCleanupFailure(cause) && error.code !== 'CLEANUP_FAILED'
    ? { code: `${error.code}_CLEANUP_FAILED`, message: `${error.message} ${messages.CLEANUP_FAILED}` }
    : error;
}

export function failedConnection(cause: unknown): TvConnectionState {
  const code = projectTvError(cause).code;
  if (code.startsWith('AUTHORIZATION_FAILED') || code.startsWith('PAIRING_REJECTED')) return 'authorization_error';
  if (code.startsWith('INVALID_TV_RESPONSE') || code.startsWith('UNSUPPORTED_CAPABILITY')) return 'compatibility_error';
  return 'unavailable';
}

export function cleanupFailure(primary: unknown, cleanup: unknown): unknown {
  const aggregate = new AggregateError([primary, new TvServiceError('CLEANUP_FAILED', 500, { cause: cleanup })], 'TV operation and cleanup failed', { cause: primary });
  if (primary instanceof WebOsError) return new WebOsError(primary.code, primary.message, { cause: aggregate });
  if (primary instanceof TvServiceError) return new TvServiceError(primary.code, primary.statusCode, { cause: aggregate });
  return new TvServiceError('TV_OPERATION_FAILED', 500, { cause: aggregate });
}

/** Observe late rejections even when a dependency ignores cancellation. */
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (cause) => { signal.removeEventListener('abort', abort); reject(cause); });
    if (signal.aborted) abort();
  });
}
