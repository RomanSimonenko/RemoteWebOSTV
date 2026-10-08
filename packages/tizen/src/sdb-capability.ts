import type { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { WebOsError, type PlatformVersionResult, type PlatformVersionDiagnostic } from '@remote-webos-tv/tv-adapter';
import type { SamsungScheduler } from './samsung-adapter.js';
export interface SdbSocket extends EventEmitter { write(frame: Buffer): boolean; destroy(): unknown }
export interface SdbDependencies { readonly scheduler: SamsungScheduler; readonly timeoutMs: number; readonly createSocket?: (host: string) => SdbSocket }
const protocolVersion = 0x0100000;
const maxPayload = 256 * 1024;

// Tizen's transport.c/common_modules.h: six LE uint32 fields, additive checksum,
// CNXN host:: and NUL-terminated OPEN capability:. command_function.c reads a
// uint16 byte length before capability text. Physically verified on TV profile.
export function readSdbPlatformVersion(host: string, signal: AbortSignal, dependencies: SdbDependencies): Promise<PlatformVersionResult> {
  if (signal.aborted) return Promise.reject(new WebOsError('CONNECTION_LOST', 'Samsung metadata cancelled'));
  return new Promise((resolve, reject) => {
    let socket: SdbSocket | undefined, settled = false, opened = false, remoteId: number | undefined;
    let buffer = Buffer.alloc(0), capability = Buffer.alloc(0), packets = 0;
    let timer: unknown;
    const finish = (result?: PlatformVersionResult, cancelled = false) => {
      if (settled) return;
      settled = true;
      dependencies.scheduler.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      for (const [event, listener] of listeners) socket?.removeListener(event, listener);
      socket?.destroy();
      if (cancelled) reject(new WebOsError('CONNECTION_LOST', 'Samsung metadata cancelled'));
      else resolve(result!);
    };
    const diagnostic = (code: PlatformVersionDiagnostic['code']) => finish({ diagnostic: { operation: 'sdb_capability', code } });
    const send = (command: string, arg0 = 0, arg1 = 0, text = '') => {
      if (settled) return;
      const payload = text ? Buffer.from(`${text}\0`) : Buffer.alloc(0);
      const header = Buffer.alloc(24), id = Buffer.from(command).readUInt32LE();
      [id, arg0, arg1, payload.length, payload.reduce((sum, byte) => sum + byte, 0), (~id) >>> 0]
        .forEach((value, index) => header.writeUInt32LE(value, index * 4));
      try { socket!.write(Buffer.concat([header, payload])); }
      catch { diagnostic('send_failed'); }
    };
    const abort = () => finish(undefined, true);
    const data = (chunk: Buffer) => {
      if (settled) return;
      if (!Buffer.isBuffer(chunk) || buffer.length + chunk.length > maxPayload + 24) { diagnostic('invalid_response'); return; }
      buffer = Buffer.concat([buffer, chunk]);
      while (!settled && buffer.length >= 24) {
        const id = buffer.readUInt32LE(0), arg0 = buffer.readUInt32LE(4), arg1 = buffer.readUInt32LE(8);
        const length = buffer.readUInt32LE(12), checksum = buffer.readUInt32LE(16), magic = buffer.readUInt32LE(20);
        if (length > maxPayload || magic !== ((~id) >>> 0)) { diagnostic('invalid_response'); return; }
        if (buffer.length < 24 + length) return;
        const command = buffer.subarray(0, 4).toString('ascii'), payload = buffer.subarray(24, 24 + length);
        buffer = buffer.subarray(24 + length);
        if (++packets > 32 || payload.reduce((sum, byte) => sum + byte, 0) !== checksum) { diagnostic('invalid_response'); return; }
        if (command === 'AUTH' || command === 'CLSE') { diagnostic('request_rejected'); return; }
        if (command === 'CNXN') {
          // Official update_version negotiates min(peer, host); modern TV peers
          // advertise a newer version but retain the host's checksum framing.
          if (opened || arg0 < protocolVersion || arg1 < 4096 || arg1 > maxPayload) { diagnostic('invalid_response'); return; }
          opened = true; send('OPEN', 1, 0, 'capability:');
        } else if (command === 'OKAY') {
          if (!opened || !arg0 || arg1 !== 1 || payload.length || remoteId !== undefined) { diagnostic('invalid_response'); return; }
          remoteId = arg0;
        } else if (command === 'WRTE') {
          if (!opened || arg1 !== 1 || !arg0 || (remoteId !== undefined && arg0 !== remoteId) || capability.length + payload.length > 65537) { diagnostic('invalid_response'); return; }
          remoteId = arg0;
          capability = Buffer.concat([capability, payload]); send('OKAY', 1, arg0);
          if (settled || capability.length < 2) continue;
          const expected = capability.readUInt16LE();
          if (capability.length < expected + 2) continue;
          if (capability.length !== expected + 2) { diagnostic('invalid_response'); return; }
          const text = capability.subarray(2).toString('utf8').replace(/\0$/, '');
          const values = (key: string) => text.split(/\r?\n/).filter((line) => line.startsWith(`${key}:`)).map((line) => line.slice(key.length + 1));
          const versions = values('platform_version'), profiles = values('profile_name');
          if (profiles.length !== 1 || profiles[0] !== 'tv' || versions.length > 1) { diagnostic('invalid_response'); return; }
          if (!versions.length || !versions[0]) { diagnostic('version_unavailable'); return; }
          if (!/^\d{1,3}(?:\.\d{1,3}){0,3}$/.test(versions[0])) { diagnostic('invalid_response'); return; }
          send('CLSE', 1, arg0);
          if (!settled) finish({ version: versions[0] });
        } else { diagnostic('invalid_response'); return; }
      }
    };
    const listeners: ReadonlyArray<readonly [string, (...args: any[]) => void]> = [
      ['connect', () => send('CNXN', protocolVersion, maxPayload, 'host::')],
      ['data', data], ['error', () => diagnostic('request_rejected')], ['close', () => diagnostic('request_rejected')],
    ];
    signal.addEventListener('abort', abort, { once: true });
    timer = dependencies.scheduler.setTimeout(() => diagnostic('timeout'), dependencies.timeoutMs);
    try {
      socket = dependencies.createSocket?.(host) ?? createConnection({ host, port: 26101 });
      for (const [event, listener] of listeners) socket.on(event, listener);
    } catch { diagnostic('request_rejected'); }
  });
}
