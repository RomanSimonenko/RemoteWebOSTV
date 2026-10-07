import { apiErrorSchema, loginResponseSchema, sessionResponseSchema, setupStatusSchema, tvStatusResponseSchema, tvOperationSchema, tvCommandResultSchema, tvRemoteStateSchema, type LoginRequest, type SetupRequest, type StartTvOperation, type TvOperation, type TvStatusResponse, type TvCommandRequest, type TvCommandResult, type TvRemoteState } from '@remote-webos-tv/contracts';
import { tvPowerStateSchema, tvPowerOperationSchema, type TvPowerRequest } from '@remote-webos-tv/contracts';
import { tvDevicesResponseSchema, addTvResponseSchema, type TvId, type AddTvRequest } from '@remote-webos-tv/contracts';

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super('API request failed'); }
  get commandRejectedBeforeDispatch(): boolean { return validatedCommandRejections.has(this); }
  get powerRejectedBeforeDispatch(): boolean { return validatedPowerRejections.has(this); }
}
// Status/code alone (including a manually constructed ApiFailure) cannot prove
// delivery. Only this module's validated command error response can mark it.
const validatedCommandRejections = new WeakSet<ApiFailure>();
const validatedPowerRejections = new WeakSet<ApiFailure>();
const powerRejections: Readonly<Record<number, readonly string[]>> = {
  400: ['BAD_REQUEST'], 403: ['FORBIDDEN'],
  409: ['OPERATION_CONFLICT', 'INVALID_ACTION', 'SERVICE_CLOSED', 'CLEANUP_FAILED', 'TV_UNAVAILABLE', 'WOL_NOT_CONFIGURED', 'POWER_RECEIPT_CAPACITY'],
  422: ['UNSUPPORTED_CAPABILITY'], 429: ['RATE_LIMITED'],
};

async function request(path: string, init?: RequestInit, resultStatuses: readonly number[] = []): Promise<Response> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store', ...init }); }
  catch { throw new ApiFailure(0, 'NETWORK_ERROR'); }
  if (!response.ok && !resultStatuses.includes(response.status)) {
    let code = 'UNEXPECTED_ERROR';
    let commandRejected = false;
    let powerRejected = false;
    try {
      const parsed = apiErrorSchema.safeParse(await response.json());
      if (parsed.success) {
        code = parsed.data.code;
        commandRejected = /^\/(?:tv|tvs\/[^/]+)\/commands$/.test(path) && ((response.status === 400 && code === 'BAD_REQUEST') || (response.status === 403 && code === 'FORBIDDEN'));
        powerRejected = /^\/(?:tv|tvs\/[^/]+)\/power$/.test(path) && init?.method === 'POST' && !!powerRejections[response.status]?.includes(code);
      }
    } catch { /* Malformed responses remain generic API failures. */ }
    const failure = new ApiFailure(response.status, code);
    if (commandRejected) validatedCommandRejections.add(failure);
    if (powerRejected) validatedPowerRejections.add(failure);
    throw failure;
  }
  return response;
}

async function parsed<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
  try { return schema.parse(await response.json()); }
  catch { throw new ApiFailure(response.status, 'INVALID_RESPONSE'); }
}

const jsonHeaders = { 'content-type': 'application/json' };
const tvPath = (tvId?: TvId) => tvId ? `/tvs/${encodeURIComponent(tvId)}` : '/tv';
export const api = {
  async tvDevices(signal?: AbortSignal) { return parsed(await request('/tvs', { signal: signal ?? null }), tvDevicesResponseSchema); },
  async addTv(input: AddTvRequest, csrfToken: string, signal?: AbortSignal) {
    return parsed(await request('/tvs', { method: 'POST', headers: { ...jsonHeaders, 'x-csrf-token': csrfToken }, body: JSON.stringify(input), signal: signal ?? null }), addTvResponseSchema);
  },
  async status() { return parsed(await request('/setup/status'), setupStatusSchema); },
  async session() { return parsed(await request('/auth/session'), sessionResponseSchema); },
  async setup(input: SetupRequest) { await request('/setup', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }); },
  async login(input: LoginRequest) { return parsed(await request('/auth/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }), loginResponseSchema); },
  async logout(csrfToken: string) { await request('/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrfToken } }); },
  // JSON cannot carry an explicitly undefined optional property. The validated
  // wire values satisfy the contracts' stricter exact-optional public types.
  async tvStatus(signal?: AbortSignal, tvId?: TvId): Promise<TvStatusResponse> { return await parsed(await request(tvPath(tvId), { signal: signal ?? null }), tvStatusResponseSchema) as TvStatusResponse; },
  async startTvOperation(input: StartTvOperation, csrfToken: string, signal?: AbortSignal, tvId?: TvId) {
    return await parsed(await request(`${tvPath(tvId)}/operations`, { method: 'POST', headers: { ...jsonHeaders, 'x-csrf-token': csrfToken }, body: JSON.stringify(input), signal: signal ?? null }), tvOperationSchema) as TvOperation;
  },
  async cancelTvOperation(id: string, csrfToken: string, signal?: AbortSignal, tvId?: TvId) {
    return await parsed(await request(`${tvPath(tvId)}/operations/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'x-csrf-token': csrfToken }, signal: signal ?? null }), tvOperationSchema) as TvOperation;
  },
  async remoteState(signal?: AbortSignal, tvId?: TvId): Promise<TvRemoteState> {
    return parsed(await request(`${tvPath(tvId)}/remote`, { signal: signal ?? null }), tvRemoteStateSchema);
  },
  async powerState(signal?: AbortSignal, tvId?: TvId) {
    return parsed(await request(`${tvPath(tvId)}/power`, { signal: signal ?? null }), tvPowerStateSchema);
  },
  async setTvMac(mac: string | null, csrfToken: string, signal?: AbortSignal, tvId?: TvId) {
    return parsed(await request(`${tvPath(tvId)}/mac`, { method: 'PUT', headers: { ...jsonHeaders, 'x-csrf-token': csrfToken }, body: JSON.stringify({ mac }), signal: signal ?? null }), tvPowerStateSchema);
  },
  async startPower(input: TvPowerRequest, csrfToken: string, signal?: AbortSignal, tvId?: TvId) {
    const response = await request(`${tvPath(tvId)}/power`, { method: 'POST', headers: { ...jsonHeaders, 'x-csrf-token': csrfToken }, body: JSON.stringify(input), signal: signal ?? null });
    const result = await parsed(response, tvPowerOperationSchema);
    if (response.status !== 202 || result.id !== input.id || result.action !== input.action) throw new ApiFailure(response.status, 'INVALID_RESPONSE');
    return result;
  },
  async cancelPower(id: string, csrfToken: string, signal?: AbortSignal, tvId?: TvId) {
    const response = await request(`${tvPath(tvId)}/power/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'x-csrf-token': csrfToken }, signal: signal ?? null });
    const result = await parsed(response, tvPowerOperationSchema);
    if (response.status !== 200 || result.id !== id) throw new ApiFailure(response.status, 'INVALID_RESPONSE');
    return result;
  },
  async sendCommand(input: TvCommandRequest, csrfToken: string, signal?: AbortSignal, tvId?: TvId): Promise<TvCommandResult> {
    // Only this route carries a command result on these non-success statuses.
    // Auth/schema errors continue through the shared API-error handling.
    const response = await request(`${tvPath(tvId)}/commands`, { method: 'POST', headers: { ...jsonHeaders, 'x-csrf-token': csrfToken }, body: JSON.stringify(input), signal: signal ?? null }, [409, 422, 429, 503, 504]);
    const result = await parsed(response, tvCommandResultSchema);
    const expectedStatus = result.outcome === 'sent' ? 200 : result.outcome === 'unknown' ? 504 : {
      TV_UNAVAILABLE: 409, TV_BUSY: 409, UNSUPPORTED_CAPABILITY: 422, APP_NOT_AVAILABLE: 422, APP_LIST_UNAVAILABLE: 503, COMMAND_NOT_SENT: 503, RATE_LIMITED: 429,
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
    if (error.code === 'POWER_RECEIPT_CAPACITY') return 'Войдите заново, чтобы запустить новую операцию питания.';
    if (error.code === 'WOL_NOT_CONFIGURED') return 'Сохраните MAC-адрес телевизора для включения.';
    if (error.code === 'UNSUPPORTED_CAPABILITY') return 'Телевизор не поддерживает эту команду.';
    if (error.code === 'TV_UNAVAILABLE') return 'Телевизор недоступен. Обновите статус.';
    if (error.code === 'CLEANUP_FAILED') return 'Не удалось освободить соединение с телевизором. Проверьте сервис.';
    if (error.code === 'INVALID_RESPONSE') return 'Сервер вернул некорректный ответ. Обновите статус.';
    if (error.status === 401 && error.code === 'INVALID_CREDENTIALS') return 'Неверное имя или пароль.';
    if (error.status === 429) return 'Слишком много попыток. Попробуйте позже.';
    if (error.status === 403) return 'Действие отклонено. Проверьте данные и попробуйте снова.';
    if (error.status === 400) return 'Проверьте введённые данные.';
    if (error.code === 'NETWORK_ERROR') return 'Нет связи с сервером. Попробуйте снова.';
  }
  return 'Не удалось выполнить запрос. Попробуйте снова.';
}
