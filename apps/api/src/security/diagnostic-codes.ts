// Exact values only: never emit an arbitrary code, message, filename or path.
export const systemDiagnosticCodes = [
  'EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EROFS', 'EIO',
  'EMFILE', 'ENFILE', 'EADDRINUSE', 'EADDRNOTAVAIL',
  'SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_READONLY', 'SQLITE_IOERR',
  'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_FULL', 'SQLITE_CANTOPEN', 'SQLITE_CONSTRAINT',
] as const;
