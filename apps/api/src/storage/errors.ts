export const storageErrorMessages = {
  STORAGE_OPEN_FAILED: 'Database storage could not be opened',
  STORAGE_DATA_DIRECTORY_INVALID: 'Data directory path must be a directory',
  STORAGE_DATABASE_PATH_INVALID: 'Database path must be a regular file',
  STORAGE_SCHEMA_NEWER: 'Database schema version is newer than this application',
  STORAGE_SCHEMA_INVALID: 'Invalid database schema or migration history',
  STORAGE_OWNER_SCHEMA_INVALID: 'Owner table schema does not match migration history',
  STORAGE_MIGRATIONS_INVALID: 'Application migrations must be complete and sequential',
  STORAGE_BACKUP_FAILED: 'Database backup failed',
  STORAGE_MIGRATION_FAILED: 'Database migration failed',
  STORAGE_CLOSE_FAILED: 'Database close failed',
} as const;

export type StorageErrorCode = keyof typeof storageErrorMessages;

export class StorageStartupError extends Error {
  constructor(readonly code: StorageErrorCode, cause?: unknown) {
    super(storageErrorMessages[code], { cause });
    this.name = 'StorageStartupError';
  }
}
