import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import type { ProbeResult } from '@remote-webos-tv/webos';
import {
  ReportValidationError,
  mergeProbeResult,
  readCompatibilityReport,
  renderCompatibilityMarkdown,
  writeCompatibilityMarkdown,
  writeCompatibilityReport,
  type CompatibilityReport,
} from '../src/report.js';

const createdDirectories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-report-test-'));
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const report: CompatibilityReport = {
  schemaVersion: 1,
  generatedAt: '2026-09-03T10:00:00.000Z',
  library: { name: 'lgtv2', version: '2.0.0' },
  tv: {
    model: '43UP76906LE',
    platformVersion: '6.5.3',
    firmwareVersion: '03.40.85',
  },
  transport: 'wss:3001',
  checks: [
    { operation: 'pair', status: 'pass', durationMs: 17 },
    {
      operation: 'pointer',
      status: 'unsupported',
      durationMs: 5,
      code: 'POINTER_FORBIDDEN',
      note: 'Телевизор запретил управление кнопками.',
    },
  ],
  decision: 'pending',
};

describe('compatibility report', () => {
  test('writes and reads strict JSON atomically with owner-only permissions', async () => {
    const directory = await createDirectory();

    await writeCompatibilityReport(directory, report);

    await expect(readCompatibilityReport(directory)).resolves.toEqual(report);
    const entries = await readdir(directory);
    expect(entries).toEqual(['report.json']);
    const metadata = await stat(join(directory, 'report.json'));
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))).toEqual(
      report,
    );
  });

  test.each([
    { ...report, host: '192.0.2.10' },
    { ...report, clientKey: 'synthetic-client-key' },
    { ...report, tv: { ...report.tv, mac: '02:00:00:00:00:01' } },
    {
      ...report,
      checks: [{ ...report.checks[0], rawPayload: 'synthetic-raw-frame' }],
    },
  ])('rejects fields outside the report allowlist', async (candidate) => {
    const directory = await createDirectory();

    await expect(
      writeCompatibilityReport(directory, candidate),
    ).rejects.toBeInstanceOf(ReportValidationError);
    expect(await readdir(directory)).toEqual([]);
  });

  test.each([
    'unexpected device 192.0.2.10',
    'unexpected device fe80::1',
    'unexpected device 02:00:00:00:00:01',
    'unexpected device 02-00-00-00-00-01',
    'unexpected device 020000000001',
    'unexpected path /var/lib/remote-webos-tv/secret',
    'unexpected path C:\\Users\\Synthetic\\secret',
    'unexpected path C:/Users/Synthetic/secret',
    'unexpected path \\\\synthetic-server\\share\\secret',
    'unexpected terminal control \u001b[31m',
  ])('rejects sensitive value in an allowed note: %s', async (note) => {
    const directory = await createDirectory();
    const candidate = {
      ...report,
      checks: [
        {
          ...report.checks[0],
          note,
        },
      ],
    };

    await expect(
      writeCompatibilityReport(directory, candidate),
    ).rejects.toBeInstanceOf(ReportValidationError);
  });

  test('renders Markdown only from a validated report without sensitive data', async () => {
    const directory = await createDirectory();
    await writeCompatibilityReport(directory, report);

    const markdown = await writeCompatibilityMarkdown(directory);

    expect(markdown).toContain('# Совместимость RemoteWebOSTV');
    expect(markdown).toContain('43UP76906LE');
    expect(markdown).toContain('| pair | pass | 17 |');
    expect(await readFile(join(directory, 'report.md'), 'utf8')).toBe(markdown);
    expect(markdown).not.toMatch(/client.?key/i);
    expect(markdown).not.toMatch(/(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i);

    expect(() =>
      renderCompatibilityMarkdown({ ...report, host: '192.0.2.10' }),
    ).toThrowError(ReportValidationError);
  });

  test('merges latest checks and keeps prior evidence absent from a command result', () => {
    const probeResult: ProbeResult = {
      checks: [
        { operation: 'pair', status: 'pass', durationMs: 8 },
        { operation: 'button', status: 'pass', durationMs: 2 },
      ],
      identity: report.tv,
      capabilities: {
        ssap: true,
        pointer: true,
        powerOff: true,
        wakeOnLan: true,
        apps: true,
        inputs: true,
        textInput: true,
        notifications: true,
      },
      transport: 'ws:3000',
      macAddressCount: 1,
    };

    const merged = mergeProbeResult(
      report,
      probeResult,
      new Date('2026-09-03T11:00:00.000Z'),
    );

    expect(merged.generatedAt).toBe('2026-09-03T11:00:00.000Z');
    expect(merged.transport).toBe('ws:3000');
    expect(merged.checks.map(({ operation, durationMs }) => ({ operation, durationMs }))).toEqual([
      { operation: 'pair', durationMs: 8 },
      { operation: 'pointer', durationMs: 5 },
      { operation: 'button', durationMs: 2 },
    ]);
    expect(merged.decision).toBe('pending');
    expect(JSON.stringify(merged)).not.toContain('macAddressCount');
  });
});
