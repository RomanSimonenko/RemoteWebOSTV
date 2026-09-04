import { describe, expect, test } from 'vitest';

import {
  CliArgumentError,
  HELP_TEXT,
  parseCliArguments,
} from '../src/args.js';

const syntheticHost = '192.0.2.10';

describe('parseCliArguments', () => {
  test('parses pair, check and report commands with explicit paths', () => {
    expect(
      parseCliArguments([
        'pair',
        '--host',
        syntheticHost,
        '--data-dir',
        '.local/protocol-probe',
      ]),
    ).toEqual({
      command: 'pair',
      host: syntheticHost,
      dataDir: '.local/protocol-probe',
    });
    expect(
      parseCliArguments([
        'check',
        '--host',
        syntheticHost,
        '--data-dir',
        '.local/protocol-probe',
      ]),
    ).toEqual({
      command: 'check',
      host: syntheticHost,
      dataDir: '.local/protocol-probe',
    });
    expect(
      parseCliArguments(['report', '--data-dir', '.local/protocol-probe']),
    ).toEqual({ command: 'report', dataDir: '.local/protocol-probe' });
  });

  test('allows client-key reset only as an explicit pair option', () => {
    expect(
      parseCliArguments([
        'pair',
        '--host',
        syntheticHost,
        '--data-dir',
        '.local/protocol-probe',
        '--reset-client-key',
      ]),
    ).toEqual({
      command: 'pair',
      host: syntheticHost,
      dataDir: '.local/protocol-probe',
      resetClientKey: true,
    });

    expect(() =>
      parseCliArguments([
        'check',
        '--host',
        syntheticHost,
        '--data-dir',
        '.local/protocol-probe',
        '--reset-client-key',
      ]),
    ).toThrowError(/reset-client-key.*pair/i);
    expect(() =>
      parseCliArguments([
        'report',
        '--data-dir',
        '.local/protocol-probe',
        '--reset-client-key',
      ]),
    ).toThrowError(/reset-client-key.*pair/i);
  });

  test('parses operation-specific command arguments', () => {
    expect(
      parseCliArguments([
        'command',
        '--host',
        syntheticHost,
        '--data-dir',
        '.local/protocol-probe',
        '--operation',
        'button',
        '--button',
        'HOME',
      ]),
    ).toMatchObject({
      command: 'command',
      operation: 'button',
      args: { button: 'HOME' },
    });
    expect(
      parseCliArguments([
        'command',
        '--host',
        syntheticHost,
        '--data-dir',
        '.local/protocol-probe',
        '--operation',
        'set-volume',
        '--volume',
        '23',
      ]),
    ).toMatchObject({
      operation: 'set-volume',
      args: { volume: 23 },
    });
  });

  test.each([
    [['pair', '--data-dir', 'data'], 'host'],
    [['check', '--host', syntheticHost], 'data-dir'],
    [['report'], 'data-dir'],
    [
      ['command', '--host', syntheticHost, '--data-dir', 'data'],
      'operation',
    ],
    [
      [
        'command',
        '--host',
        syntheticHost,
        '--data-dir',
        'data',
        '--operation',
        'button',
      ],
      'button',
    ],
  ])('rejects missing required argument in %j', (argv, expectedName) => {
    expect(() => parseCliArguments(argv)).toThrowError(CliArgumentError);
    expect(() => parseCliArguments(argv)).toThrowError(
      new RegExp(expectedName, 'i'),
    );
  });

  test.each(['power-off', 'wake'])(
    'requires explicit device-state confirmation for %s',
    (operation) => {
      const argv = [
        'command',
        '--host',
        syntheticHost,
        '--data-dir',
        'data',
        '--operation',
        operation,
        ...(operation === 'wake' ? ['--mac', '02:00:00:00:00:01'] : []),
      ];
      expect(() => parseCliArguments(argv)).toThrowError(
        /confirm-device-state-change/i,
      );

      expect(
        parseCliArguments([...argv, '--confirm-device-state-change']),
      ).toMatchObject({ command: 'command', operation });
    },
  );

  test('requires a valid explicit MAC for standalone wake', () => {
    const base = [
      'command',
      '--host',
      syntheticHost,
      '--data-dir',
      'data',
      '--operation',
      'wake',
      '--confirm-device-state-change',
    ];
    expect(() => parseCliArguments(base)).toThrowError(/mac/i);
    expect(() =>
      parseCliArguments([...base, '--mac', 'not-a-mac']),
    ).toThrowError(/mac/i);
  });

  test('returns help without requiring command arguments', () => {
    expect(parseCliArguments(['--help'])).toEqual({ command: 'help' });
    expect(parseCliArguments(['--', '--help'])).toEqual({ command: 'help' });
    expect(HELP_TEXT).toContain('pair');
    expect(HELP_TEXT).toContain('check');
    expect(HELP_TEXT).toContain('command');
    expect(HELP_TEXT).toContain('report');
    expect(HELP_TEXT).toMatch(/изменяют состояние телевизора/i);
  });
});
