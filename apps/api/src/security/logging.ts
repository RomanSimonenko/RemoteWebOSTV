import type { Writable } from 'node:stream';

export function safeListenTextResolver(): string {
  return 'API listening';
}

export function safeCauseTypes(error: unknown): string[] {
  const types: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current) && types.length < 5) {
    seen.add(current);
    types.push(['Error', 'TypeError', 'SyntaxError', 'StorageUnavailableError', 'ZodError'].includes(current.name) ? current.name : 'OtherError');
    current = current.cause;
  }
  return types;
}

export function safeLoggerOptions(stream?: Writable) {
  return {
    level: 'info',
    base: null,
    ...(stream ? { stream } : {}),
    serializers: {
      req: (request: { method: string }) => ({ method: request.method }),
      res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
      err: (error: unknown) => ({ type: 'Error', message: 'Redacted error', stack: 'Redacted', causeTypes: safeCauseTypes(error) }),
      error: (error: unknown) => ({ causeTypes: safeCauseTypes(error) }),
    },
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie', 'req.headers.x-csrf-token',
        'request.headers.authorization', 'request.headers.cookie', 'request.headers.x-csrf-token',
        'password', 'token', 'cookie', 'authorization', 'csrfToken',
        '*.password', '*.token', '*.cookie', '*.authorization', '*.csrfToken',
      ],
      censor: '[REDACTED]',
    },
  };
}
