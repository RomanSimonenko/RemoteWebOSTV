import { AuthMasterKeyStorageError } from './auth/sessions.js';
import { AppConfigError } from './config.js';

export function formatStartupError(error: unknown): string {
  if (error instanceof AuthMasterKeyStorageError) return 'Auth storage unavailable';
  if (error instanceof AppConfigError) return error.message;
  return 'API startup failed';
}
