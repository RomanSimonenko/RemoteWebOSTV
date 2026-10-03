import type { ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { storageErrorMessages } from '../../api/src/storage/errors.js';
import { systemDiagnosticCodes } from '../../api/src/security/diagnostic-codes.js';

const allowedCodes = new Set<string>([
  ...Object.keys(storageErrorMessages), ...systemDiagnosticCodes,
  'AUTH_STORAGE_UNAVAILABLE', 'SETUP_UNAVAILABLE', 'INVALID_SETUP_TOKEN', 'INVALID_OWNER_INPUT',
  // Typed TV initialization/cleanup failures emitted by formatStartupError.
  'KEY_STORE_CORRUPT', 'KEY_STORE_WRITE_FAILED', 'CLEANUP_FAILED', 'STORAGE_FAILED',
]);

export async function waitForListening(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let tail = '';
    let stderrTail = '';
    let done = false;
    const codes = new Set<string>();
    const addCode = (code: string) => { if (codes.size < 8) codes.add(code); };
    const inspectLine = (line: string) => {
      const startup = /^(API startup failed|Auth storage unavailable)(?: \[([A-Z0-9_,]+)\])?$/.exec(line);
      if (startup) {
        if (startup[1] === 'Auth storage unavailable') addCode('AUTH_STORAGE_UNAVAILABLE');
        for (const code of (startup[2] ?? '').split(',')) if (allowedCodes.has(code)) addCode(code);
      }
      const missingModule = /^\s*code: '(MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)',?\s*$/.exec(line);
      if (missingModule) addCode(missingModule[1]!);
      if (/^REMOTE_WEBOS_(DATA_DIR|HOST|PORT|PUBLIC_ORIGIN|SECURE_COOKIES|TRUSTED_PROXY) (is required|must )/.test(line)) addCode('CONFIGURATION_ERROR');
    };
    const stderr = (chunk: Buffer) => {
      // Retain only a bounded partial line, and only allowlisted codes as evidence.
      for (const piece of chunk.toString('utf8').split(/(?<=\n)/)) {
        stderrTail = (stderrTail + piece).slice(-512);
        if (piece.endsWith('\n')) { inspectLine(stderrTail.trimEnd()); stderrTail = ''; }
      }
    };
    const diagnostic = () => `cause=${[...codes].join(',') || 'unavailable'}`;
    const timeout = setTimeout(() => finish(new Error(`API did not start (${diagnostic()})`)), 15_000);
    const output = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-200);
      if (tail.includes('API listening')) finish();
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      inspectLine(stderrTail);
      const safeCode = code === null ? 'none' : Number.isSafeInteger(code) && code >= 0 && code <= 255 ? String(code) : 'unknown';
      const safeSignal = signal === null ? 'none' : Object.hasOwn(constants.signals, signal) ? signal : 'unknown';
      finish(new Error(`API exited before listening (exit=${safeCode}, signal=${safeSignal}, ${diagnostic()})`));
    };
    const spawnFailed = (error: Error) => {
      if ('code' in error && typeof error.code === 'string' && allowedCodes.has(error.code)) addCode(error.code);
      finish(new Error(`API process could not start (${diagnostic()})`));
    };
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      child.stdout?.off('data', output);
      child.stderr?.off('data', stderr);
      child.off('close', exited);
      child.off('error', spawnFailed);
      child.stdout?.resume();
      child.stderr?.resume();
      error ? reject(error) : resolve();
    };
    child.stdout?.on('data', output);
    child.stderr?.on('data', stderr);
    // close follows stdio completion, so a final stderr chunk is not lost at exit.
    child.once('close', exited);
    child.once('error', spawnFailed);
  });
}
