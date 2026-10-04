import dgram from 'node:dgram';

import { TvPowerSendError, WebOsError } from './errors.js';

const wakeAddress = '255.255.255.255';
const wakePort = 9;
const wakeCount = 3;
const wakeIntervalMs = 100;

type WakeTimer = ReturnType<typeof setTimeout> | undefined;

export interface WakeSocket {
  once(event: 'close', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  bind(callback: () => void): void;
  setBroadcast(enabled: boolean): void;
  send(
    packet: Buffer,
    offset: number,
    length: number,
    port: number,
    address: string,
    callback: (error?: Error | null) => void,
  ): void;
  close(): void;
}

export interface WakeOnLanDependencies {
  readonly createSocket: (signal: AbortSignal) => WakeSocket;
  readonly schedule: (callback: () => void, delayMs: number) => WakeTimer;
  readonly clearSchedule: (timer: WakeTimer) => void;
}

const defaultDependencies: WakeOnLanDependencies = {
  createSocket: (signal) =>
    dgram.createSocket({ type: 'udp4', signal }) as WakeSocket,
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  clearSchedule: (timer) => clearTimeout(timer),
};

export async function sendWakeOnLan(
  macAddresses: readonly string[],
  signal: AbortSignal,
  dependencies: WakeOnLanDependencies = defaultDependencies,
): Promise<void> {
  let delivery: 'not_sent' | 'unknown' = 'not_sent';
  try {
    throwIfAborted(signal);
    const packets = [...new Set(macAddresses.map(normalizeMacAddress))].map(
      createMagicPacket,
    );
    if (packets.length === 0) {
      throw new WebOsError(
        'UNSUPPORTED_CAPABILITY',
        'Wake-on-LAN requires at least one MAC address',
      );
    }

    return await new Promise<void>((resolve, reject) => {
      let socket: WakeSocket;
      let timer: WakeTimer;
      let packetIndex = 0;
      let settled = false;
      let outcome:
        | { readonly status: 'success' }
        | { readonly status: 'error'; readonly error: unknown }
        | undefined;

      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        dependencies.clearSchedule(timer);
        signal.removeEventListener('abort', abort);
        if (outcome?.status === 'success') {
          resolve();
          return;
        }
        reject(
          outcome?.status === 'error'
            ? outcome.error
            : new WebOsError('CONNECTION_LOST', 'Wake-on-LAN socket closed'),
        );
      };

      const closeWith = (
        nextOutcome:
          | { readonly status: 'success' }
          | { readonly status: 'error'; readonly error: unknown },
      ) => {
        if (outcome) {
          return;
        }
        outcome = nextOutcome;
        dependencies.clearSchedule(timer);
        try {
          socket.close();
        } catch (closeError) {
          outcome = {
            status: 'error',
            error:
              nextOutcome.status === 'error'
                ? new AggregateError(
                    [nextOutcome.error, closeError],
                    'Wake-on-LAN operation and socket cleanup failed',
                    { cause: nextOutcome.error },
                  )
                : closeError,
          };
          settle();
        }
      };

      const abort = () => {
        if (!outcome || outcome.status === 'success') {
          outcome = {
            status: 'error',
            error: new WebOsError(
              'CONNECTION_LOST',
              'Wake-on-LAN operation was cancelled',
            ),
          };
        }
        dependencies.clearSchedule(timer);
      };

      signal.addEventListener('abort', abort, { once: true });
      try {
        socket = dependencies.createSocket(signal);
      } catch (error) {
        signal.removeEventListener('abort', abort);
        reject(error);
        return;
      }

      socket.once('close', settle);
      socket.once('error', (error) => closeWith({ status: 'error', error }));

      const sendNext = () => {
        if (outcome || signal.aborted) {
          return;
        }
        const packet = packets[packetIndex % packets.length]!;
        delivery = 'unknown';
        try {
          socket.send(
            packet,
            0,
            packet.length,
            wakePort,
            wakeAddress,
            (error) => {
              if (error) {
                closeWith({ status: 'error', error });
                return;
              }
              packetIndex += 1;
              if (packetIndex >= packets.length * wakeCount) {
                closeWith({ status: 'success' });
                return;
              }
              timer = dependencies.schedule(sendNext, wakeIntervalMs);
            },
          );
        } catch (cause) {
          closeWith({ status: 'error', error: cause });
        }
      };

      try {
        socket.bind(() => {
          if (outcome || signal.aborted) {
            return;
          }
          try {
            socket.setBroadcast(true);
          } catch (error) {
            closeWith({ status: 'error', error });
            return;
          }
          sendNext();
        });
      } catch (error) {
        closeWith({ status: 'error', error });
      }
    });
  } catch (cause) {
    throw new TvPowerSendError(cause instanceof WebOsError ? cause.code : 'CONNECTION_LOST', delivery, 'Wake-on-LAN failed', { cause });
  }
}

function normalizeMacAddress(macAddress: string): string {
  const compact = macAddress.replaceAll(':', '').replaceAll('-', '');
  if (!/^[0-9a-f]{12}$/i.test(compact)) {
    throw new WebOsError('UNKNOWN', 'Wake-on-LAN received an invalid MAC address');
  }
  return compact.toUpperCase();
}

function createMagicPacket(macAddress: string): Buffer {
  const mac = Buffer.from(macAddress, 'hex');
  const packet = Buffer.alloc(6 + 16 * mac.length, 0xff);
  for (let offset = 6; offset < packet.length; offset += mac.length) {
    mac.copy(packet, offset);
  }
  return packet;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WebOsError('CONNECTION_LOST', 'Wake-on-LAN operation was cancelled');
  }
}
