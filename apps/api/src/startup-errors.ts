import { AuthMasterKeyStorageError } from './auth/sessions.js';
import { AppConfigError } from './config.js';
import { OwnerSetupError } from './auth/service.js';
import { StorageStartupError } from './storage/errors.js';
import { systemDiagnosticCodes } from './security/diagnostic-codes.js';
import { WebOsError } from '@remote-webos-tv/webos';
import { TvServiceError } from './tv/service.js';

export function formatStartupError(error: unknown, fallback = 'API startup failed'): string {
  if (error instanceof AppConfigError) return error.message;
  const codes = new Set<string>();
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  // Bound both traversal and output, including AggregateError cleanup branches.
  for (let visited = 0; pending.length && visited < 8; visited++) {
    const current = pending.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof StorageStartupError || current instanceof OwnerSetupError) codes.add(current.code);
    else if (current instanceof WebOsError || current instanceof TvServiceError) codes.add(current.code);
    else if (current instanceof AuthMasterKeyStorageError && current !== error) codes.add('AUTH_STORAGE_UNAVAILABLE');
    else if ('code' in current && typeof current.code === 'string' && (systemDiagnosticCodes as readonly string[]).includes(current.code)) codes.add(current.code);
    if (current instanceof AggregateError) pending.unshift(...current.errors.slice(0, 8 - visited));
    else if (current.cause !== undefined) pending.unshift(current.cause);
  }
  const message = error instanceof AuthMasterKeyStorageError ? 'Auth storage unavailable' : fallback;
  return codes.size ? `${message} [${[...codes].join(',')}]` : message;
}
