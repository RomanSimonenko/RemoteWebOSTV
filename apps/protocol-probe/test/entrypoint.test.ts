import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));
// The package pretest builds the entrypoint and its dependency artifacts.
const cliPath = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

describe('compiled CLI entrypoint', () => {
  test('starts with Node and prints help after the package build', () => {
    const start = spawnSync(
      process.execPath,
      [cliPath, '--help'],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      },
    );

    const errorCode = (start.error as NodeJS.ErrnoException | undefined)?.code;
    const moduleErrorCode = /code: '(MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)'/.exec(start.stderr)?.[1];
    const diagnostic = `CLI process failed (exit=${start.status ?? 'none'}, signal=${start.signal ?? 'none'}, error=${errorCode ?? moduleErrorCode ?? 'none'})`;
    expect(start.error === undefined, diagnostic).toBe(true);
    expect(start.status, diagnostic).toBe(0);
    expect(start.stdout).toContain('protocol-probe pair');
    expect(start.stdout).toContain('protocol-probe check');
    expect(start.stdout).toContain('protocol-probe command');
    expect(start.stdout).toContain('protocol-probe report');
  }, 15_000);
});
