import type {
  TvApp,
  TvButton,
  TvCapabilities,
  TvInput,
  TvSnapshot,
} from '@remote-webos-tv/contracts';
import { describe, expect, test } from 'vitest';

import type { PairingRequest, PairingResult } from '../src/adapter.js';
import { WebOsError } from '../src/errors.js';
import {
  SAFE_PROBE_OPERATIONS,
  runProbe,
  type ProbeAdapter,
  type ProbeArguments,
  type ProbeOperation,
} from '../src/probe.js';

const capabilities: TvCapabilities = {
  ssap: true,
  pointer: true,
  powerOff: true,
  wakeOnLan: true,
  apps: true,
  inputs: true,
  textInput: true,
  notifications: true,
};

const pairingResult: PairingResult = {
  clientKey: 'synthetic-probe-client-key',
  identity: {
    model: '43UP76906LE',
    platformVersion: '6.5.3',
    firmwareVersion: '03.40.85',
  },
  capabilities,
  transport: 'wss:3001',
  macAddresses: ['02:00:00:00:00:01'],
};

class FakeProbeAdapter implements ProbeAdapter {
  readonly calls: string[] = [];
  readonly failures = new Map<ProbeOperation, WebOsError>();
  result: PairingResult = pairingResult;

  async pair(_request: PairingRequest): Promise<PairingResult> {
    this.record('pair');
    return this.result;
  }

  async readSnapshot(_signal: AbortSignal): Promise<TvSnapshot> {
    this.record('snapshot');
    return {
      connection: 'available',
      identity: this.result.identity,
      capabilities: this.result.capabilities,
      transport: this.result.transport,
      volume: 17,
      muted: false,
    };
  }

  async openPointerSocket(_signal: AbortSignal): Promise<void> {
    this.record('pointer');
  }

  async listApps(_signal: AbortSignal): Promise<readonly TvApp[]> {
    this.record('apps');
    return [{ id: 'youtube.leanback.v4', name: 'YouTube' }];
  }

  async listInputs(_signal: AbortSignal): Promise<readonly TvInput[]> {
    this.record('inputs');
    return [{ id: 'HDMI_1', label: 'HDMI 1', connected: true }];
  }

  async sendButton(button: TvButton, _signal: AbortSignal): Promise<void> {
    this.record('button');
    this.calls.push(`button-value:${button}`);
  }

  async setVolume(volume: number, _signal: AbortSignal): Promise<void> {
    this.record('set-volume');
    this.calls.push(`volume-value:${volume}`);
  }

  async launchApp(id: string, _signal: AbortSignal): Promise<void> {
    this.record('launch-app');
    this.calls.push(`app-value:${id}`);
  }

  async switchInput(id: string, _signal: AbortSignal): Promise<void> {
    this.record('switch-input');
    this.calls.push(`input-value:${id}`);
  }

  async insertText(text: string, _signal: AbortSignal): Promise<void> {
    this.record('text');
    this.calls.push(`text-value:${text}`);
  }

  async createNotification(
    message: string,
    _signal: AbortSignal,
  ): Promise<void> {
    this.record('notification');
    this.calls.push(`notification-value:${message}`);
  }

  async powerOff(_signal: AbortSignal): Promise<void> {
    this.record('power-off');
  }

  async wake(macAddresses: readonly string[], _signal: AbortSignal): Promise<void> {
    this.record('wake');
    this.calls.push(`wake-count:${macAddresses.length}`);
  }

  async disconnect(): Promise<void> {
    this.calls.push('disconnect');
  }

  private record(operation: ProbeOperation): void {
    this.calls.push(operation);
    const failure = this.failures.get(operation);
    if (failure) {
      throw failure;
    }
  }
}

function createNow(): () => Date {
  let current = 0;
  return () => {
    current += 7;
    return new Date(current);
  };
}

function createArguments(
  overrides: Partial<ProbeArguments> = {},
): ProbeArguments {
  return {
    button: 'HOME',
    volume: 23,
    appId: 'youtube.leanback.v4',
    inputId: 'HDMI_1',
    text: 'synthetic text',
    notification: 'synthetic notification',
    ...overrides,
  };
}

async function execute(
  adapter: FakeProbeAdapter,
  operations?: readonly ProbeOperation[],
  args = createArguments(),
  signal = new AbortController().signal,
) {
  return runProbe({
    adapter,
    host: 'tv.invalid',
    signal,
    now: createNow(),
    args,
    ...(operations ? { operations } : {}),
  });
}

describe('runProbe', () => {
  test('runs only the complete safe operation set by default', async () => {
    const adapter = new FakeProbeAdapter();

    const result = await execute(adapter);

    expect(result.checks.map((check) => check.operation)).toEqual(
      SAFE_PROBE_OPERATIONS,
    );
    expect(result.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(adapter.calls).not.toContain('button');
    expect(adapter.calls).not.toContain('set-volume');
    expect(adapter.calls).not.toContain('power-off');
    expect(result).toMatchObject({
      identity: pairingResult.identity,
      capabilities,
      transport: 'wss:3001',
      macAddressCount: 1,
    });
    expect(result.checks.every((check) => check.durationMs === 7)).toBe(true);
  });

  test('runs mutating operations only when explicitly listed', async () => {
    const adapter = new FakeProbeAdapter();
    const mutating: readonly ProbeOperation[] = [
      'pair',
      'button',
      'set-volume',
      'launch-app',
      'switch-input',
      'text',
      'notification',
      'power-off',
      'wake',
    ];

    const result = await execute(adapter, mutating);

    expect(result.checks.map(({ operation, status }) => ({ operation, status }))).toEqual(
      mutating.map((operation) => ({ operation, status: 'pass' })),
    );
    expect(adapter.calls).toEqual([
      'pair',
      'button',
      'button-value:HOME',
      'set-volume',
      'volume-value:23',
      'launch-app',
      'app-value:youtube.leanback.v4',
      'switch-input',
      'input-value:HDMI_1',
      'text',
      'text-value:synthetic text',
      'notification',
      'notification-value:synthetic notification',
      'power-off',
      'wake',
      'wake-count:1',
      'disconnect',
    ]);
  });

  test('records an optional capability as unsupported and continues', async () => {
    const adapter = new FakeProbeAdapter();
    adapter.failures.set(
      'pointer',
      new WebOsError('POINTER_FORBIDDEN', 'synthetic pointer failure'),
    );

    const result = await execute(adapter, ['pair', 'pointer', 'apps']);

    expect(result.checks).toEqual([
      expect.objectContaining({ operation: 'pair', status: 'pass' }),
      expect.objectContaining({
        operation: 'pointer',
        status: 'unsupported',
        code: 'POINTER_FORBIDDEN',
      }),
      expect.objectContaining({ operation: 'apps', status: 'pass' }),
    ]);
  });

  test('marks every later operation not-run after pairing fails', async () => {
    const adapter = new FakeProbeAdapter();
    adapter.failures.set(
      'pair',
      new WebOsError('NETWORK_UNREACHABLE', 'synthetic network failure'),
    );

    const result = await execute(adapter, ['pair', 'snapshot', 'apps', 'button']);

    expect(result.checks.map(({ operation, status }) => ({ operation, status }))).toEqual([
      { operation: 'pair', status: 'fail' },
      { operation: 'snapshot', status: 'not-run' },
      { operation: 'apps', status: 'not-run' },
      { operation: 'button', status: 'not-run' },
    ]);
    expect(adapter.calls).toEqual(['pair', 'disconnect']);
  });

  test('disconnects after cancellation', async () => {
    const adapter = new FakeProbeAdapter();
    adapter.failures.set(
      'pair',
      new WebOsError('CONNECTION_LOST', 'synthetic cancellation'),
    );
    const controller = new AbortController();
    controller.abort();

    await execute(adapter, ['pair', 'snapshot'], createArguments(), controller.signal);

    expect(adapter.calls).toEqual(['pair', 'disconnect']);
  });

  test('does not run online operations after power-off but still allows wake', async () => {
    const adapter = new FakeProbeAdapter();

    const result = await execute(adapter, [
      'pair',
      'power-off',
      'set-volume',
      'launch-app',
      'wake',
    ]);

    expect(result.checks.map(({ operation, status }) => ({ operation, status }))).toEqual([
      { operation: 'pair', status: 'pass' },
      { operation: 'power-off', status: 'pass' },
      { operation: 'set-volume', status: 'not-run' },
      { operation: 'launch-app', status: 'not-run' },
      { operation: 'wake', status: 'pass' },
    ]);
    expect(adapter.calls).not.toContain('set-volume');
    expect(adapter.calls).not.toContain('launch-app');
    expect(adapter.calls).toContain('wake');
  });

  test('rejects wake when pairing returned no valid MAC', async () => {
    const adapter = new FakeProbeAdapter();
    adapter.result = { ...pairingResult, macAddresses: ['not-a-mac'] };

    const result = await execute(adapter, ['pair', 'wake']);

    expect(result.checks[1]).toMatchObject({
      operation: 'wake',
      status: 'fail',
      code: 'INVALID_TV_RESPONSE',
    });
    expect(adapter.calls).not.toContain('wake');
  });

  test('allows standalone wake with an explicitly supplied valid MAC', async () => {
    const adapter = new FakeProbeAdapter();

    const result = await execute(
      adapter,
      ['wake'],
      createArguments({ macAddresses: ['02:00:00:00:00:01'] }),
    );

    expect(result.checks).toEqual([
      { operation: 'wake', status: 'pass', durationMs: 7 },
    ]);
    expect(adapter.calls).toEqual(['wake', 'wake-count:1', 'disconnect']);
  });
});
