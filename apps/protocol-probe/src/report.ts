import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

import type { ProbeCheck, ProbeResult } from '@remote-webos-tv/webos';
import { z } from 'zod';

const reportJsonFileName = 'report.json';
const reportMarkdownFileName = 'report.md';

const probeOperationSchema = z.enum([
  'pair',
  'reconnect',
  'identity',
  'snapshot',
  'pointer',
  'apps',
  'inputs',
  'macs',
  'button',
  'set-volume',
  'launch-app',
  'switch-input',
  'text',
  'notification',
  'power-off',
  'wake',
]);
const webOsErrorCodeSchema = z.enum([
  'NETWORK_UNREACHABLE',
  'PAIRING_REJECTED',
  'PAIRING_TIMEOUT',
  'AUTHORIZATION_FAILED',
  'POINTER_FORBIDDEN',
  'UNSUPPORTED_CAPABILITY',
  'INVALID_TV_RESPONSE',
  'CONNECTION_LOST',
  'KEY_STORE_CORRUPT',
  'KEY_STORE_WRITE_FAILED',
  'UNKNOWN',
]);
const probeCheckSchema = z
  .object({
    operation: probeOperationSchema,
    status: z.enum(['pass', 'fail', 'unsupported', 'not-run']),
    durationMs: z.number().finite().nonnegative(),
    code: webOsErrorCodeSchema.optional(),
    note: z.string().trim().min(1).optional(),
  })
  .strict();
const tvSchema = z
  .object({
    model: z.string().trim().min(1),
    platformVersion: z.string().trim().min(1).optional(),
    firmwareVersion: z.string().trim().min(1).optional(),
  })
  .strict();

export const compatibilityReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().refine(isCanonicalIsoTimestamp),
    library: z
      .object({ name: z.literal('lgtv2'), version: z.literal('2.0.0') })
      .strict(),
    tv: tvSchema,
    transport: z.enum(['wss:3001', 'ws:3000']).optional(),
    checks: z.array(probeCheckSchema),
    decision: z.enum([
      'pending',
      'use-lgtv2',
      'fork-lgtv2',
      'replace-lgtv2',
    ]),
  })
  .strict();

type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

export type CompatibilityReport = DeepReadonly<
  z.infer<typeof compatibilityReportSchema>
>;

export class ReportValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReportValidationError';
  }
}

export class ReportStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReportStorageError';
  }
}

export function parseCompatibilityReport(
  candidate: unknown,
): CompatibilityReport {
  try {
    const report = compatibilityReportSchema.parse(candidate);
    assertNoSensitiveValues(report);
    return report;
  } catch (cause) {
    if (cause instanceof ReportValidationError) {
      throw cause;
    }
    throw new ReportValidationError('Compatibility report is invalid', {
      cause,
    });
  }
}

export async function writeCompatibilityReport(
  directory: string,
  candidate: unknown,
): Promise<CompatibilityReport> {
  const report = parseCompatibilityReport(candidate);
  await atomicWrite(
    directory,
    reportJsonFileName,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

export async function readCompatibilityReport(
  directory: string,
): Promise<CompatibilityReport> {
  let serialized: string;
  try {
    serialized = await readFile(join(directory, reportJsonFileName), 'utf8');
  } catch (cause) {
    throw new ReportStorageError('Unable to read compatibility report', {
      cause,
    });
  }

  try {
    return parseCompatibilityReport(JSON.parse(serialized));
  } catch (cause) {
    if (cause instanceof ReportValidationError) {
      throw cause;
    }
    throw new ReportValidationError('Compatibility report JSON is invalid', {
      cause,
    });
  }
}

export function mergeProbeResult(
  previous: CompatibilityReport | undefined,
  probe: ProbeResult,
  generatedAt: Date,
): CompatibilityReport {
  const existing = previous ? parseCompatibilityReport(previous) : undefined;
  const identity = probe.identity ?? existing?.tv;
  if (!identity) {
    throw new ReportValidationError(
      'A successful identity check is required before creating a report',
    );
  }

  const checks = mergeChecks(existing?.checks ?? [], probe.checks);
  return parseCompatibilityReport({
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    library: { name: 'lgtv2', version: '2.0.0' },
    tv: identity,
    ...(probe.transport ?? existing?.transport
      ? { transport: probe.transport ?? existing?.transport }
      : {}),
    checks,
    decision: existing?.decision ?? 'pending',
  });
}

export function renderCompatibilityMarkdown(candidate: unknown): string {
  const report = parseCompatibilityReport(candidate);
  const lines = [
    '# Совместимость RemoteWebOSTV',
    '',
    `- Сформирован: ${escapeMarkdown(report.generatedAt)}`,
    `- Библиотека: ${report.library.name} ${report.library.version}`,
    `- Модель: ${escapeMarkdown(report.tv.model)}`,
    ...(report.tv.platformVersion
      ? [`- webOS: ${escapeMarkdown(report.tv.platformVersion)}`]
      : []),
    ...(report.tv.firmwareVersion
      ? [`- Прошивка: ${escapeMarkdown(report.tv.firmwareVersion)}`]
      : []),
    ...(report.transport ? [`- Транспорт: ${report.transport}`] : []),
    `- Решение: ${report.decision}`,
    '',
    '| Проверка | Статус | мс | Код | Примечание |',
    '| --- | --- | ---: | --- | --- |',
    ...report.checks.map(
      (check) =>
        `| ${check.operation} | ${check.status} | ${check.durationMs} | ${
          check.code ?? '—'
        } | ${check.note ? escapeMarkdown(check.note) : '—'} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

export async function writeCompatibilityMarkdown(
  directory: string,
): Promise<string> {
  const report = await readCompatibilityReport(directory);
  const markdown = renderCompatibilityMarkdown(report);
  await atomicWrite(directory, reportMarkdownFileName, markdown);
  return markdown;
}

function mergeChecks(
  existing: CompatibilityReport['checks'],
  incoming: readonly ProbeCheck[],
): readonly (CompatibilityReport['checks'][number] | ProbeCheck)[] {
  const merged = new Map<
    ProbeCheck['operation'],
    CompatibilityReport['checks'][number] | ProbeCheck
  >(existing.map((check) => [check.operation, check]));
  for (const check of incoming) {
    merged.set(check.operation, check);
  }
  return [...merged.values()];
}

async function atomicWrite(
  directory: string,
  fileName: string,
  contents: string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, fileName);
  const temporary = join(
    directory,
    `.${fileName}.tmp-${process.pid}-${randomUUID()}`,
  );
  let handle: FileHandle | undefined;

  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new ReportStorageError('Unable to atomically write report', {
      cause,
    });
  }
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function assertNoSensitiveValues(candidate: unknown): void {
  const patterns = [
    /client[-_ ]?key/i,
    /\b[0-9a-f]{2}(?:(?::[0-9a-f]{2}){5}|(?:-[0-9a-f]{2}){5})\b/i,
    /\b[0-9a-f]{12}\b/i,
    /[\u0000-\u001f\u007f-\u009f]/,
    /(?:^|[=:\s"'(])\/(?![\/\s])/,
    /(?:^|[=:\s"'(])\/\/[^/\s]+\//,
    /[A-Za-z]:[\\/]/,
    /(?:^|[=:\s"'(])\\\\[^\\/\s]+[\\/]/,
    /\bfile:\/\/\/[^\s]+/i,
  ];

  const pending = [candidate];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (
        patterns.some((pattern) => pattern.test(value)) ||
        containsIpAddress(value)
      ) {
        throw new ReportValidationError(
          'Compatibility report contains a forbidden sensitive value',
        );
      }
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      pending.push(...Object.values(value));
    }
  }
}

function containsIpAddress(value: string): boolean {
  const candidates = [
    ...(value.match(/(?:\d{1,3}\.){3}\d{1,3}/g) ?? []),
    ...(value.match(/\[[0-9a-f:.%]+\]|[0-9a-f:.%]+/gi) ?? []),
  ];
  return candidates.some(
    (candidate) => isIP(normalizeIpAddressCandidate(candidate)) !== 0,
  );
}

function normalizeIpAddressCandidate(candidate: string): string {
  let address = candidate
    .replace(/^\[|\]$/g, '')
    .replace(/[),.;!?]+$/g, '');
  if (/^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(':'));
  }
  const zoneIndex = address.indexOf('%');
  return zoneIndex === -1 ? address : address.slice(0, zoneIndex);
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
