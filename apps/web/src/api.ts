import { apiErrorSchema, loginResponseSchema, sessionResponseSchema, setupStatusSchema, tvStatusResponseSchema, tvOperationSchema, tvCommandResultSchema, tvRemoteStateSchema, type LoginRequest, type SetupRequest, type StartTvOperation, type TvOperation, type TvStatusResponse, type TvCommandRequest, type TvCommandResult, type TvRemoteState } from '@remote-webos-tv/contracts';

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super('API request failed'); }
}

async function request(path: string, init?: RequestInit, resultStatuses: readonly number[] = []): Promise<Response> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store', ...init }); }
  catch { throw new ApiFailure(0, 'NETWORK_ERROR'); }
  if (!response.ok && !resultStatuses.includes(response.status)) {
    let code = 'UNEXPECTED_ERROR';
    try {
      const parsed = apiErrorSchema.safeParse(await response.json());
      if (parsed.success) code = parsed.data.code;
    } catch { /* Malformed responses remain generic API failures. */ }
    throw new ApiFailure(response.status, code);
  }
  return response;
}

async function parsed<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
  try { return schema.parse(await response.json()); }
  catch { throw new ApiFailure(response.status, 'INVALID_RESPONSE'); }
}

const jsonHeaders = { 'content-type': 'application/json' };
export const api = {
  async status() { return parsed(await request('/setup/status'), setupStatusSchema); },
  async session() { return parsed(await request('/auth/session'), sessionResponseSchema); },
  async setup(input: SetupRequest) { await request('/setup', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }); },
  async login(input: LoginRequest) { return parsed(await request('/auth/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }), loginResponseSchema); },
  async logout(csrfToken: string) { await request('/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrfToken } }); },
  // JSON cannot carry an explicitly undefined optional property. The validated
  // wire values satisfy the contracts' stricter exact-optional public types.
  async tvStatus(signal?: AbortSignal): Promise<TvStatusResponse> { return await parsed(await request('/tv', { signal: signal ?? null }), tvStatusResponseSchema) as TvStatusResponse; },
  async startTvOperation(input: StartTvOperation, csrfToken: string, signal?: AbortSignal) {
    return await parsed(await request('/tv/operations', { method: 'POST', headers: { ...jsonHeaders, 'x-csrf-token': csrfToken }, body: JSON.stringify(input), signal: signal ?? null }), tvOperationSchema) as TvOperation;
  },
  async cancelTvOperation(id: string, csrfToken: string, signal?: AbortSignal) {
    return await parsed(await request(`/tv/operations/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'x-csrf-token': csrfToken }, signal: signal ?? null }), tvOperationSchema) as TvOperation;
  },
  async remoteState(signal?: AbortSignal): Promise<TvRemoteState> {
    return parsed(await request('/tv/remote', { signal: signal ?? null }), tvRemoteStateSchema);
  },
  async sendCommand(input: TvCommandRequest, csrfToken: string, signal?: AbortSignal): Promise<TvCommandResult> {
    // Only this route carries a command result on these non-success statuses.
    // Auth/schema errors continue through the shared API-error handling.
    const response = await request('/tv/commands', { method: 'POST', headers: { ...jsonHeaders, 'x-csrf-token': csrfToken }, body: JSON.stringify(input), signal: signal ?? null }, [409, 422, 429, 503, 504]);
    const result = await parsed(response, tvCommandResultSchema);
    const expectedStatus = result.outcome === 'sent' ? 200 : result.outcome === 'unknown' ? 504 : {
      TV_UNAVAILABLE: 409, TV_BUSY: 409, UNSUPPORTED_CAPABILITY: 422, COMMAND_NOT_SENT: 503, RATE_LIMITED: 429,
    }[result.error.code];
    if (result.id !== input.id || response.status !== expectedStatus) throw new ApiFailure(response.status, 'INVALID_RESPONSE');
    return result;
  },
};

export function friendlyError(error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.code === 'OPERATION_CONFLICT') return 'Другая операция с телевизором ещё не завершена.';
    if (error.code === 'INVALID_ACTION') return 'Это действие недоступно для текущей настройки телевизора.';
    if (error.code === 'OPERATION_NOT_FOUND') return 'Операция с телевизором не найдена. Обновите статус.';
    if (error.code === 'SERVICE_CLOSED') return 'Сервис телевизора остановлен.';
    if (error.code === 'INVALID_RESPONSE') return 'Сервер вернул некорректный ответ. Обновите статус.';
    if (error.status === 401 && error.code === 'INVALID_CREDENTIALS') return 'Неверное имя или пароль.';
    if (error.status === 429) return 'Слишком много попыток. Попробуйте позже.';
    if (error.status === 403) return 'Действие отклонено. Проверьте данные и попробуйте снова.';
    if (error.status === 400) return 'Проверьте введённые данные.';
    if (error.code === 'NETWORK_ERROR') return 'Нет связи с сервером. Попробуйте снова.';
  }
  return 'Не удалось выполнить запрос. Попробуйте снова.';
}
