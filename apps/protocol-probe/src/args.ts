import { parseArgs } from 'node:util';

import { tvButtonSchema } from '@remote-webos-tv/contracts';
import type {
  MutatingProbeOperation,
  ProbeArguments,
} from '@remote-webos-tv/webos';

export const HELP_TEXT = `RemoteWebOSTV protocol probe

Использование:
  protocol-probe pair --host <host> --data-dir <directory> [--reset-client-key]
  protocol-probe check --host <host> --data-dir <directory>
  protocol-probe command --host <host> --data-dir <directory> --operation <name>
  protocol-probe report --data-dir <directory>

Операции command:
  button --button <name>
  set-volume --volume <0..100>
  launch-app --app-id <id>
  switch-input --input-id <id>
  text --text <value>
  notification --message <value>
  power-off --confirm-device-state-change
  wake --mac <address> --confirm-device-state-change

Внимание: command запускает операции, которые изменяют состояние телевизора.
power-off и wake требуют явного --confirm-device-state-change.
Адрес ТВ, MAC и ключ сопряжения не выводятся и не попадают в отчёт.
--reset-client-key разрешён только для явного повторного сопряжения pair.
`;

export class CliArgumentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CliArgumentError';
  }
}

export type CliArguments =
  | { readonly command: 'help' }
  | {
      readonly command: 'pair' | 'check';
      readonly host: string;
      readonly dataDir: string;
      readonly resetClientKey?: true;
    }
  | {
      readonly command: 'command';
      readonly host: string;
      readonly dataDir: string;
      readonly operation: MutatingProbeOperation;
      readonly args: ProbeArguments & {
        readonly macAddresses?: readonly string[];
      };
    }
  | { readonly command: 'report'; readonly dataDir: string };

const mutatingOperations = new Set<MutatingProbeOperation>([
  'button',
  'set-volume',
  'launch-app',
  'switch-input',
  'text',
  'notification',
  'power-off',
  'wake',
]);

export function parseCliArguments(argv: readonly string[]): CliArguments {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...normalizedArgv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        host: { type: 'string' },
        'data-dir': { type: 'string' },
        operation: { type: 'string' },
        button: { type: 'string' },
        volume: { type: 'string' },
        'app-id': { type: 'string' },
        'input-id': { type: 'string' },
        text: { type: 'string' },
        message: { type: 'string' },
        mac: { type: 'string' },
        'confirm-device-state-change': { type: 'boolean' },
        'reset-client-key': { type: 'boolean' },
      },
    });
  } catch (cause) {
    throw new CliArgumentError('Некорректные аргументы CLI.', { cause });
  }

  if (parsed.values.help) {
    return { command: 'help' };
  }
  if (parsed.positionals.length !== 1) {
    throw new CliArgumentError('Укажите ровно одну команду: pair, check, command или report.');
  }

  const command = parsed.positionals[0];
  const dataDir = requiredText(parsed.values['data-dir'], 'data-dir');
  if (parsed.values['reset-client-key'] && command !== 'pair') {
    throw new CliArgumentError('--reset-client-key разрешён только для pair.');
  }
  if (command === 'report') {
    return { command, dataDir };
  }
  if (command !== 'pair' && command !== 'check' && command !== 'command') {
    throw new CliArgumentError('Неизвестная команда CLI.');
  }

  const host = requiredText(parsed.values.host, 'host');
  if (command === 'pair') {
    return {
      command,
      host,
      dataDir,
      ...(parsed.values['reset-client-key'] ? { resetClientKey: true } : {}),
    };
  }
  if (command === 'check') {
    return { command, host, dataDir };
  }

  const rawOperation = requiredText(parsed.values.operation, 'operation');
  if (!mutatingOperations.has(rawOperation as MutatingProbeOperation)) {
    throw new CliArgumentError('Неизвестная mutating-операция.');
  }
  const operation = rawOperation as MutatingProbeOperation;
  if (
    (operation === 'power-off' || operation === 'wake') &&
    !parsed.values['confirm-device-state-change']
  ) {
    throw new CliArgumentError(
      `${operation} требует --confirm-device-state-change.`,
    );
  }

  return {
    command,
    host,
    dataDir,
    operation,
    args: parseOperationArguments(operation, parsed.values),
  };
}

function parseOperationArguments(
  operation: MutatingProbeOperation,
  values: ReturnType<typeof parseArgs>['values'],
): ProbeArguments & { readonly macAddresses?: readonly string[] } {
  switch (operation) {
    case 'button': {
      const button = tvButtonSchema.safeParse(
        requiredText(values.button, 'button'),
      );
      if (!button.success) {
        throw new CliArgumentError('Неизвестное имя button.');
      }
      return { button: button.data };
    }
    case 'set-volume': {
      const volume = Number(requiredText(values.volume, 'volume'));
      if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
        throw new CliArgumentError('volume должен быть целым числом от 0 до 100.');
      }
      return { volume };
    }
    case 'launch-app':
      return { appId: requiredText(values['app-id'], 'app-id') };
    case 'switch-input':
      return { inputId: requiredText(values['input-id'], 'input-id') };
    case 'text':
      return { text: requiredText(values.text, 'text') };
    case 'notification':
      return { notification: requiredText(values.message, 'message') };
    case 'power-off':
      return {};
    case 'wake':
      return { macAddresses: [parseMac(requiredText(values.mac, 'mac'))] };
  }
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CliArgumentError(`Обязательный аргумент --${name} не задан.`);
  }
  return value.trim();
}

function parseMac(value: string): string {
  if (!/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(value)) {
    throw new CliArgumentError('mac должен содержать корректный MAC-адрес.');
  }
  const compact = value.replaceAll(':', '').replaceAll('-', '').toUpperCase();
  return compact.match(/.{2}/g)?.join(':') ?? '';
}
