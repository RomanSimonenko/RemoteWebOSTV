import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('compiled CLI entrypoint', () => {
  test('starts with Node and prints help after the package build', () => {
    const build = spawnSync(
      'pnpm',
      ['--filter', '@remote-webos-tv/protocol-probe', 'build'],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
      },
    );

    expect(build.status, build.stderr).toBe(0);

    const start = spawnSync(
      'pnpm',
      [
        '--filter',
        '@remote-webos-tv/protocol-probe',
        'start',
        '--',
        '--help',
      ],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
      },
    );

    expect(start.status, start.stderr).toBe(0);
    expect(start.stdout).toContain('protocol-probe pair');
    expect(start.stdout).toContain('protocol-probe check');
    expect(start.stdout).toContain('protocol-probe command');
    expect(start.stdout).toContain('protocol-probe report');
  }, 15_000);
});
