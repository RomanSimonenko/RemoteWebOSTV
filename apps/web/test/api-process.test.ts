// @vitest-environment node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { waitForListening } from './api-process.js';

test('failed browser fixture reports an allowlisted cause and exit code without child secrets', async () => {
  const child = spawn(process.execPath, ['-e', `
    process.stderr.write('synthetic-secret'.repeat(10000) + '\\n');
    process.stderr.write('API startup failed [STORAGE_SCHEMA_NEWER]\\n');
    process.stderr.write('token=synthetic-secret\\n');
    process.exitCode = 7;
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const failure = await waitForListening(child).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect.soft(message).toContain('STORAGE_SCHEMA_NEWER');
  expect.soft(message).toContain('exit=7');
  expect(message).not.toContain('synthetic-secret');
  expect(message.length).toBeLessThan(500);
});

test('browser fixture ignores arbitrary diagnostic codes and reports signal termination', async () => {
  const child = spawn(process.execPath, ['-e', `
    process.stderr.write('API startup failed [synthetic-secret]\\n', () => process.kill(process.pid, 'SIGTERM'));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const failure = await waitForListening(child).catch((error: Error) => error);
  expect((failure as Error).message).toContain('signal=SIGTERM');
  expect((failure as Error).message).not.toContain('synthetic-secret');
});

test('browser fixture names a missing Node entrypoint without exposing its path or stack', async () => {
  const path = fileURLToPath(new URL('./absent-synthetic-private-entry.cjs', import.meta.url));
  const child = spawn(process.execPath, [path], { stdio: ['ignore', 'pipe', 'pipe'] });
  const failure = await waitForListening(child).catch((error: Error) => error);
  expect((failure as Error).message).toContain('MODULE_NOT_FOUND');
  expect((failure as Error).message).toContain('exit=1');
  expect((failure as Error).message).not.toContain(path);
});

test('browser fixture accepts readiness and removes its diagnostic listeners', async () => {
  const child = spawn(process.execPath, ['-e', `process.stdout.write('API listening\\n');`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await expect(waitForListening(child)).resolves.toBeUndefined();
  expect(child.stdout?.listenerCount('data')).toBe(0);
  expect(child.stderr?.listenerCount('data')).toBe(0);
});
