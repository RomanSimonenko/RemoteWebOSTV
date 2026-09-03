import type {
  TvButton,
  TvCapabilities,
  TvIdentity,
  TvTransport,
} from '@remote-webos-tv/contracts';

import type { PairingResult, WebOsAdapter } from './adapter.js';
import { WebOsError, type WebOsErrorCode } from './errors.js';
import { parseMacAddress } from './response-parsers.js';

export type SafeProbeOperation =
  | 'pair'
  | 'reconnect'
  | 'identity'
  | 'snapshot'
  | 'pointer'
  | 'apps'
  | 'inputs'
  | 'macs';

export type MutatingProbeOperation =
  | 'button'
  | 'set-volume'
  | 'launch-app'
  | 'switch-input'
  | 'text'
  | 'notification'
  | 'power-off'
  | 'wake';

export type ProbeOperation = SafeProbeOperation | MutatingProbeOperation;
export type ProbeCheckStatus = 'pass' | 'fail' | 'unsupported' | 'not-run';

export const SAFE_PROBE_OPERATIONS = [
  'pair',
  'reconnect',
  'identity',
  'snapshot',
  'pointer',
  'apps',
  'inputs',
  'macs',
] as const satisfies readonly SafeProbeOperation[];

export interface ProbeCheck {
  readonly operation: ProbeOperation;
  readonly status: ProbeCheckStatus;
  readonly durationMs: number;
  readonly code?: WebOsErrorCode;
  readonly note?: string;
}

export interface ProbeArguments {
  readonly button?: TvButton;
  readonly volume?: number;
  readonly appId?: string;
  readonly inputId?: string;
  readonly text?: string;
  readonly notification?: string;
}

export interface ProbeAdapter extends WebOsAdapter {
  setVolume(volume: number, signal: AbortSignal): Promise<void>;
  launchApp(id: string, signal: AbortSignal): Promise<void>;
  switchInput(id: string, signal: AbortSignal): Promise<void>;
  insertText(text: string, signal: AbortSignal): Promise<void>;
  createNotification(message: string, signal: AbortSignal): Promise<void>;
  powerOff(signal: AbortSignal): Promise<void>;
  wake(macAddresses: readonly string[], signal: AbortSignal): Promise<void>;
}

export interface RunProbeOptions {
  readonly adapter: ProbeAdapter;
  readonly host: string;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  readonly args: ProbeArguments;
  readonly operations?: readonly ProbeOperation[];
}

export interface ProbeResult {
  readonly checks: readonly ProbeCheck[];
  readonly identity?: TvIdentity;
  readonly capabilities?: TvCapabilities;
  readonly transport?: TvTransport;
  readonly macAddressCount: number;
}

const onlineOperations = new Set<ProbeOperation>([
  'snapshot',
  'pointer',
  'apps',
  'inputs',
  'button',
  'set-volume',
  'launch-app',
  'switch-input',
  'text',
  'notification',
  'power-off',
]);

export async function runProbe(options: RunProbeOptions): Promise<ProbeResult> {
  const operations = options.operations ?? SAFE_PROBE_OPERATIONS;
  const checks: ProbeCheck[] = [];
  let pairing: PairingResult | undefined;
  let pairingBlocked = false;
  let online = false;

  try {
    for (const operation of operations) {
      if (pairingBlocked || (requiresPairing(operation) && !pairing)) {
        checks.push(notRun(operation));
        continue;
      }
      if (onlineOperations.has(operation) && !online) {
        checks.push(notRun(operation));
        continue;
      }

      const startedAt = options.now().getTime();
      try {
        switch (operation) {
          case 'pair':
            pairing = await options.adapter.pair({
              host: options.host,
              signal: options.signal,
            });
            online = true;
            break;
          case 'reconnect': {
            const previousPairing = requirePairing(pairing);
            await options.adapter.disconnect();
            pairing = await options.adapter.pair({
              host: options.host,
              clientKey: previousPairing.clientKey,
              signal: options.signal,
            });
            online = true;
            break;
          }
          case 'identity':
            requirePairing(pairing);
            break;
          case 'snapshot':
            await options.adapter.readSnapshot(options.signal);
            break;
          case 'pointer':
            await options.adapter.openPointerSocket(options.signal);
            break;
          case 'apps':
            await options.adapter.listApps(options.signal);
            break;
          case 'inputs':
            await options.adapter.listInputs(options.signal);
            break;
          case 'macs':
            requireValidMacAddresses(requirePairing(pairing).macAddresses, false);
            break;
          case 'button':
            await options.adapter.sendButton(
              requireArgument(options.args.button, 'button'),
              options.signal,
            );
            break;
          case 'set-volume':
            await options.adapter.setVolume(
              requireVolume(options.args.volume),
              options.signal,
            );
            break;
          case 'launch-app':
            await options.adapter.launchApp(
              requireText(options.args.appId, 'app id'),
              options.signal,
            );
            break;
          case 'switch-input':
            await options.adapter.switchInput(
              requireText(options.args.inputId, 'input id'),
              options.signal,
            );
            break;
          case 'text':
            await options.adapter.insertText(
              requireText(options.args.text, 'text'),
              options.signal,
            );
            break;
          case 'notification':
            await options.adapter.createNotification(
              requireText(options.args.notification, 'notification'),
              options.signal,
            );
            break;
          case 'power-off':
            await options.adapter.powerOff(options.signal);
            online = false;
            break;
          case 'wake':
            await options.adapter.wake(
              requireValidMacAddresses(
                requirePairing(pairing).macAddresses,
                true,
              ),
              options.signal,
            );
            break;
        }

        checks.push({
          operation,
          status: 'pass',
          durationMs: durationSince(startedAt, options.now),
        });
      } catch (cause) {
        const error = toProbeError(cause);
        const status = isOptionalCapabilityError(error)
          ? 'unsupported'
          : 'fail';
        checks.push({
          operation,
          status,
          durationMs: durationSince(startedAt, options.now),
          code: error.code,
          note: error.toSafeDiagnostic().message,
        });

        if (operation === 'pair' || operation === 'reconnect') {
          pairingBlocked = true;
          online = false;
        } else if (error.code === 'CONNECTION_LOST') {
          online = false;
        }
      }
    }
  } finally {
    await options.adapter.disconnect();
  }

  return {
    checks,
    ...(pairing
      ? {
          identity: pairing.identity,
          capabilities: pairing.capabilities,
          transport: pairing.transport,
          macAddressCount: pairing.macAddresses.length,
        }
      : { macAddressCount: 0 }),
  };
}

function requiresPairing(operation: ProbeOperation): boolean {
  return operation !== 'pair';
}

function notRun(operation: ProbeOperation): ProbeCheck {
  return { operation, status: 'not-run', durationMs: 0 };
}

function requirePairing(pairing: PairingResult | undefined): PairingResult {
  if (!pairing) {
    throw new WebOsError(
      'CONNECTION_LOST',
      'Probe operation requires a successful pairing',
    );
  }
  return pairing;
}

function requireArgument<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new WebOsError('UNKNOWN', `Probe argument ${name} is required`);
  }
  return value;
}

function requireText(value: string | undefined, name: string): string {
  const text = requireArgument(value, name).trim();
  if (text.length === 0) {
    throw new WebOsError('UNKNOWN', `Probe argument ${name} must not be empty`);
  }
  return text;
}

function requireVolume(value: number | undefined): number {
  const volume = requireArgument(value, 'volume');
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
    throw new WebOsError('UNKNOWN', 'Probe volume must be an integer from 0 to 100');
  }
  return volume;
}

function requireValidMacAddresses(
  macAddresses: readonly string[],
  requiredForWake: boolean,
): readonly string[] {
  if (macAddresses.length === 0) {
    throw new WebOsError(
      'UNSUPPORTED_CAPABILITY',
      requiredForWake
        ? 'Wake-on-LAN requires at least one MAC address'
        : 'TV did not expose a MAC address',
    );
  }
  return macAddresses.map(parseMacAddress);
}

function durationSince(startedAt: number, now: () => Date): number {
  return Math.max(0, now().getTime() - startedAt);
}

function toProbeError(cause: unknown): WebOsError {
  if (cause instanceof WebOsError) {
    return cause;
  }
  return new WebOsError('UNKNOWN', 'Probe operation failed', { cause });
}

function isOptionalCapabilityError(error: WebOsError): boolean {
  return (
    error.code === 'POINTER_FORBIDDEN' ||
    error.code === 'UNSUPPORTED_CAPABILITY'
  );
}
