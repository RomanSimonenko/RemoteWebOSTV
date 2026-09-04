import { describe, expect, test, vi } from 'vitest';

import type {
  ClientKeyStore,
  ProbeAdapter,
  ProbeResult,
  RunProbeOptions,
} from '@remote-webos-tv/webos';
import {
  runProtocolProbeCli,
  type MainDependencies,
} from '../src/main.js';
import type { CompatibilityReport } from '../src/report.js';

const success: ProbeResult = {
  checks: [{ operation: 'pair', status: 'pass', durationMs: 17 }],
  identity: {
    model: '43UP76906LE',
    platformVersion: '6.5.3',
    firmwareVersion: '03.40.85',
  },
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
  transport: 'wss:3001',
  macAddressCount: 1,
};

function createDeferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDependencies(result: ProbeResult = success): {
  readonly dependencies: MainDependencies;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly runProbe: ReturnType<typeof vi.fn<(options: RunProbeOptions) => Promise<ProbeResult>>>;
  readonly writeReport: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly signalListeners: Map<string, () => void>;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const signalListeners = new Map<string, () => void>();
  const registeredSignalListeners = new Map<string, () => void>();
  const disconnect = vi.fn(async () => undefined);
  const adapter = { disconnect } as unknown as ProbeAdapter;
  const keyStore = {} as ClientKeyStore;
  const runProbe = vi.fn(async (_options: RunProbeOptions) => result);
  const writeReport = vi.fn(async (_directory, report: CompatibilityReport) => report);
  const dependencies: MainDependencies = {
    createKeyStore: () => keyStore,
    createAdapter: () => adapter,
    runProbe,
    readReport: async () => undefined,
    writeReport,
    writeMarkdown: async () => '# synthetic markdown\n',
    now: () => new Date('2026-09-03T10:00:00.000Z'),
    stdout: { write: (text) => stdout.push(text) },
    stderr: { write: (text) => stderr.push(text) },
    signals: {
      once(signal, listener) {
        registeredSignalListeners.set(signal, listener);
        signalListeners.set(signal, () => {
          signalListeners.delete(signal);
          registeredSignalListeners.delete(signal);
          listener();
        });
      },
      off(signal, listener) {
        if (registeredSignalListeners.get(signal) === listener) {
          signalListeners.delete(signal);
          registeredSignalListeners.delete(signal);
        }
      },
    },
  };
  return {
    dependencies,
    stdout,
    stderr,
    runProbe,
    writeReport,
    disconnect,
    signalListeners,
  };
}

const pairArgv = [
  'pair',
  '--host',
  '192.0.2.10',
  '--data-dir',
  '.local/protocol-probe',
];

describe('runProtocolProbeCli', () => {
  test('prints help and exits 0 without constructing protocol objects', async () => {
    const harness = createDependencies();
    const createAdapter = vi.fn(harness.dependencies.createAdapter);

    const exitCode = await runProtocolProbeCli(['--help'], {
      ...harness.dependencies,
      createAdapter,
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout.join('')).toContain('protocol-probe pair');
    expect(createAdapter).not.toHaveBeenCalled();
  });

  test('returns exit 2 for arguments without starting the adapter', async () => {
    const harness = createDependencies();
    const createAdapter = vi.fn(harness.dependencies.createAdapter);

    const exitCode = await runProtocolProbeCli(['pair', '--data-dir', 'data'], {
      ...harness.dependencies,
      createAdapter,
    });

    expect(exitCode).toBe(2);
    expect(createAdapter).not.toHaveBeenCalled();
    expect(harness.stderr.join('')).toMatch(/аргумент/i);
  });

  test('runs pairing, persists an allowlisted report and redacts output', async () => {
    const harness = createDependencies();

    const exitCode = await runProtocolProbeCli(pairArgv, harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.runProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '192.0.2.10',
        operations: ['pair'],
      }),
    );
    expect(harness.writeReport).toHaveBeenCalledOnce();
    const output = harness.stdout.join('');
    expect(output).toContain('[redacted-host]');
    expect(output).toContain('43UP76906LE');
    expect(output).not.toContain('192.0.2.10');
    expect(output).not.toContain('synthetic-probe-client-key');
    expect(output).not.toContain('02:00:00:00:00:01');
    expect(harness.disconnect).toHaveBeenCalledOnce();
  });

  test('returns exit 1 when a protocol check fails', async () => {
    const harness = createDependencies({
      checks: [
        {
          operation: 'pair',
          status: 'fail',
          durationMs: 8,
          code: 'NETWORK_UNREACHABLE',
          note: 'Телевизор недоступен по сети.',
        },
      ],
      macAddressCount: 0,
    });

    const exitCode = await runProtocolProbeCli(pairArgv, harness.dependencies);

    expect(exitCode).toBe(1);
    expect(harness.stderr.join('')).toContain('NETWORK_UNREACHABLE');
    expect(harness.writeReport).not.toHaveBeenCalled();
  });

  test.each(['unsupported', 'not-run'] as const)(
    'returns exit 1 when a requested check is %s',
    async (status) => {
      const harness = createDependencies({
        ...success,
        checks: [{ operation: 'pointer', status, durationMs: 8 }],
      });

      const exitCode = await runProtocolProbeCli(
        pairArgv,
        harness.dependencies,
      );

      expect(exitCode).toBe(1);
    },
  );

  test('returns exit 1 when adapter cleanup fails', async () => {
    const harness = createDependencies();
    const disconnect = vi.fn(async () => {
      throw new Error('synthetic cleanup failure');
    });

    const exitCode = await runProtocolProbeCli(pairArgv, {
      ...harness.dependencies,
      createAdapter: () => ({ disconnect }) as unknown as ProbeAdapter,
    });

    expect(exitCode).toBe(1);
    expect(harness.stderr.join('')).toMatch(/закрыть соединение/i);
  });

  test('passes only the selected mutating operation and its validated value', async () => {
    const harness = createDependencies({
      ...success,
      checks: [
        { operation: 'pair', status: 'pass', durationMs: 10 },
        { operation: 'button', status: 'pass', durationMs: 2 },
      ],
    });

    const exitCode = await runProtocolProbeCli(
      [
        'command',
        '--host',
        '192.0.2.10',
        '--data-dir',
        '.local/protocol-probe',
        '--operation',
        'button',
        '--button',
        'HOME',
      ],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.runProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: ['pair', 'button'],
        args: { button: 'HOME' },
      }),
    );
  });

  test('runs standalone wake with an explicit MAC but never prints it', async () => {
    const harness = createDependencies({
      checks: [{ operation: 'wake', status: 'pass', durationMs: 2 }],
      macAddressCount: 0,
    });

    const exitCode = await runProtocolProbeCli(
      [
        'command',
        '--host',
        '192.0.2.10',
        '--data-dir',
        '.local/protocol-probe',
        '--operation',
        'wake',
        '--mac',
        '02:00:00:00:00:01',
        '--confirm-device-state-change',
      ],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.runProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: ['wake'],
        args: { macAddresses: ['02:00:00:00:00:01'] },
      }),
    );
    expect(harness.stdout.join('')).not.toContain('02:00:00:00:00:01');
  });

  test.each(['SIGINT', 'SIGTERM'] as const)(
    'keeps the remaining handler installed while %s cleanup is pending',
    async (signal) => {
      const harness = createDependencies();
      const cleanupStarted = createDeferred<void>();
      const allowCleanupToFinish = createDeferred<void>();
      const disconnect = vi.fn(async () => {
        cleanupStarted.resolve();
        await allowCleanupToFinish.promise;
      });
      const runProbe = vi.fn(
        async (options: RunProbeOptions): Promise<ProbeResult> => {
          harness.signalListeners.get(signal)?.();
          expect(options.signal.aborted).toBe(true);
          return {
            checks: [
              {
                operation: 'pair',
                status: 'fail',
                durationMs: 1,
                code: 'CONNECTION_LOST',
              },
            ],
            macAddressCount: 0,
          };
        },
      );

      const cli = runProtocolProbeCli(pairArgv, {
        ...harness.dependencies,
        createAdapter: () => ({ disconnect }) as unknown as ProbeAdapter,
        runProbe,
      });

      await cleanupStarted.promise;
      const remainingSignal = signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT';
      expect(harness.signalListeners.has(signal)).toBe(false);
      expect(harness.signalListeners.has(remainingSignal)).toBe(true);

      allowCleanupToFinish.resolve();
      await expect(cli).resolves.toBe(1);
      expect(harness.signalListeners.size).toBe(0);
    },
  );

  test('generates Markdown from the stored JSON report', async () => {
    const harness = createDependencies();
    const writeMarkdown = vi.fn(async () => '# verified markdown\n');

    const exitCode = await runProtocolProbeCli(
      ['report', '--data-dir', '.local/protocol-probe'],
      { ...harness.dependencies, writeMarkdown },
    );

    expect(exitCode).toBe(0);
    expect(writeMarkdown).toHaveBeenCalledWith('.local/protocol-probe');
    expect(harness.stdout.join('')).toContain('report.md');
    expect(harness.runProbe).not.toHaveBeenCalled();
  });
});
