import { apiErrorSchema, loginResponseSchema, sessionResponseSchema, setupStatusSchema, type LoginRequest, type SetupRequest } from '@remote-webos-tv/contracts';

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super('API request failed'); }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store', ...init }); }
  catch { throw new ApiFailure(0, 'NETWORK_ERROR'); }
  if (!response.ok) {
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
};

export function friendlyError(error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.status === 401 && error.code === 'INVALID_CREDENTIALS') return 'Неверное имя или пароль.';
    if (error.status === 429) return 'Слишком много попыток. Попробуйте позже.';
    if (error.status === 403) return 'Действие отклонено. Проверьте данные и попробуйте снова.';
    if (error.status === 400) return 'Проверьте введённые данные.';
    if (error.code === 'NETWORK_ERROR') return 'Нет связи с сервером. Попробуйте снова.';
  }
  return 'Не удалось выполнить запрос. Попробуйте снова.';
}
