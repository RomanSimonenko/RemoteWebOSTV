import {
  EncryptedFileKeyStore,
  Lgtv2Adapter,
  WebOsError,
  runProbe,
  type ClientKeyStore,
  type ProbeAdapter,
  type ProbeResult,
  type RunProbeOptions,
} from '@remote-webos-tv/webos';

import {
  CliArgumentError,
  HELP_TEXT,
  parseCliArguments,
  type CliArguments,
} from './args.js';
import {
  ReportStorageError,
  mergeProbeResult,
  readCompatibilityReport,
  writeCompatibilityMarkdown,
  writeCompatibilityReport,
  type CompatibilityReport,
} from './report.js';

type InterruptSignal = 'SIGINT' | 'SIGTERM';

interface TextOutput {
  write(text: string): void;
}

interface SignalRegistry {
  once(signal: InterruptSignal, listener: () => void): void;
  off(signal: InterruptSignal, listener: () => void): void;
}

interface AdapterFactoryOptions {
  readonly host: string;
  readonly keyStore: ClientKeyStore;
  readonly now: () => Date;
}

export interface MainDependencies {
  readonly createKeyStore: (directory: string) => ClientKeyStore;
  readonly createAdapter: (options: AdapterFactoryOptions) => ProbeAdapter;
  readonly runProbe: (options: RunProbeOptions) => Promise<ProbeResult>;
  readonly readReport: (
    directory: string,
  ) => Promise<CompatibilityReport | undefined>;
  readonly writeReport: (
    directory: string,
    report: CompatibilityReport,
  ) => Promise<CompatibilityReport>;
  readonly writeMarkdown: (directory: string) => Promise<string>;
  readonly now: () => Date;
  readonly stdout: TextOutput;
  readonly stderr: TextOutput;
  readonly signals: SignalRegistry;
}

const defaultDependencies: MainDependencies = {
  createKeyStore: (directory) => new EncryptedFileKeyStore({ directory }),
  createAdapter: ({ host, keyStore, now }) =>
    new Lgtv2Adapter({
      host,
      keyStore,
      requestTimeoutMs: 60_000,
      handshakeTimeoutMs: 10_000,
      now,
    }),
  runProbe,
  readReport: readOptionalReport,
  writeReport: writeCompatibilityReport,
  writeMarkdown: writeCompatibilityMarkdown,
  now: () => new Date(),
  stdout: { write: (text) => void process.stdout.write(text) },
  stderr: { write: (text) => void process.stderr.write(text) },
  signals: {
    once: (signal, listener) => process.once(signal, listener),
    off: (signal, listener) => process.off(signal, listener),
  },
};

export async function runProtocolProbeCli(
  argv: readonly string[],
  dependencies: MainDependencies = defaultDependencies,
): Promise<number> {
  let command: CliArguments;
  try {
    command = parseCliArguments(argv);
  } catch (cause) {
    dependencies.stderr.write(
      cause instanceof CliArgumentError
        ? `Ошибка аргументов: ${cause.message}\n`
        : 'Ошибка аргументов CLI.\n',
    );
    dependencies.stderr.write('Используйте --help для справки.\n');
    return 2;
  }

  if (command.command === 'help') {
    dependencies.stdout.write(HELP_TEXT);
    return 0;
  }
  if (command.command === 'report') {
    try {
      await dependencies.writeMarkdown(command.dataDir);
      dependencies.stdout.write('Обезличенный отчёт записан в report.md.\n');
      return 0;
    } catch {
      dependencies.stderr.write(
        'Не удалось построить report.md из проверенного report.json.\n',
      );
      return 1;
    }
  }

  const keyStore = dependencies.createKeyStore(command.dataDir);
  const adapter = dependencies.createAdapter({
    host: command.host,
    keyStore,
    now: dependencies.now,
  });
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    controller.abort();
  };
  dependencies.signals.once('SIGINT', interrupt);
  dependencies.signals.once('SIGTERM', interrupt);
  let exitCode = 1;

  try {
    dependencies.stdout.write(
      `[redacted-host]: запуск команды ${command.command}.\n`,
    );
    const previous = await dependencies.readReport(command.dataDir);
    const probeOptions = createProbeOptions(
      command,
      adapter,
      controller.signal,
      dependencies.now,
    );
    const result = await dependencies.runProbe(probeOptions);

    if (previous || result.identity) {
      const report = mergeProbeResult(previous, result, dependencies.now());
      await dependencies.writeReport(command.dataDir, report);
    }
    writeProbeSummary(result, dependencies);

    exitCode =
      interrupted || result.checks.some((check) => check.status !== 'pass')
        ? 1
        : 0;
  } catch (cause) {
    writeSafeFailure(cause, dependencies.stderr);
    exitCode = 1;
  } finally {
    dependencies.signals.off('SIGINT', interrupt);
    dependencies.signals.off('SIGTERM', interrupt);
    try {
      await adapter.disconnect();
    } catch {
      dependencies.stderr.write('Не удалось корректно закрыть соединение с ТВ.\n');
      exitCode = 1;
    }
  }
  return exitCode;
}

function createProbeOptions(
  command: Exclude<CliArguments, { readonly command: 'help' | 'report' }>,
  adapter: ProbeAdapter,
  signal: AbortSignal,
  now: () => Date,
): RunProbeOptions {
  if (command.command === 'command') {
    return {
      adapter,
      host: command.host,
      signal,
      now,
      args: command.args,
      operations:
        command.operation === 'wake'
          ? ['wake']
          : ['pair', command.operation],
    };
  }
  if (command.command === 'pair') {
    return {
      adapter,
      host: command.host,
      signal,
      now,
      args: {},
      operations: ['pair'],
    };
  }
  return {
    adapter,
    host: command.host,
    signal,
    now,
    args: {},
  };
}

function writeProbeSummary(
  result: ProbeResult,
  dependencies: Pick<MainDependencies, 'stdout' | 'stderr'>,
): void {
  if (result.identity) {
    dependencies.stdout.write(`Модель: ${result.identity.model}\n`);
    if (result.identity.platformVersion) {
      dependencies.stdout.write(`webOS: ${result.identity.platformVersion}\n`);
    }
    if (result.identity.firmwareVersion) {
      dependencies.stdout.write(
        `Прошивка: ${result.identity.firmwareVersion}\n`,
      );
    }
  }
  if (result.transport) {
    dependencies.stdout.write(`Транспорт: ${result.transport}\n`);
  }
  dependencies.stdout.write(
    `MAC для Wake-on-LAN: ${result.macAddressCount > 0 ? 'обнаружен' : 'не обнаружен'}\n`,
  );

  for (const check of result.checks) {
    const line = `${check.operation}: ${check.status}${
      check.code ? ` (${check.code})` : ''
    }\n`;
    if (check.status === 'fail') {
      dependencies.stderr.write(line);
    } else {
      dependencies.stdout.write(line);
    }
  }
}

function writeSafeFailure(cause: unknown, stderr: TextOutput): void {
  if (cause instanceof WebOsError) {
    const diagnostic = cause.toSafeDiagnostic();
    stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
    return;
  }
  stderr.write('Не удалось выполнить protocol probe.\n');
}

async function readOptionalReport(
  directory: string,
): Promise<CompatibilityReport | undefined> {
  try {
    return await readCompatibilityReport(directory);
  } catch (cause) {
    if (
      cause instanceof ReportStorageError &&
      hasErrorCode(cause.cause, 'ENOENT')
    ) {
      return undefined;
    }
    throw cause;
  }
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    cause.code === code
  );
}
