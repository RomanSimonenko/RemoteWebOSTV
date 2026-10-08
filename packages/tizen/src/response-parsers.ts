import type { TvIdentity } from '@remote-webos-tv/contracts';
import { WebOsError } from '@remote-webos-tv/tv-adapter';

function invalid(): never {
  // Raw response/payload must not become an error message or nested cause.
  throw new WebOsError('INVALID_TV_RESPONSE', 'Invalid Samsung protocol response');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid();
  return value;
}

export function parseSamsungIdentity(payload: unknown): TvIdentity {
  const device = record(record(payload).device);
  if (device.OS !== 'Tizen') invalid();
  const model = text(device.modelName);
  const firmware = device.firmwareVersion;
  if (firmware !== undefined && typeof firmware !== 'string') invalid();
  return { model, ...(typeof firmware === 'string' && firmware.trim() ? { firmwareVersion: firmware } : {}) };
}

export type SamsungEvent =
  | { readonly event: 'connect'; readonly credential: string }
  | { readonly event: 'unauthorized' | 'timeout' | 'error' | 'other' };

/** Validates the observed full owned-client shape, never merely socket open. */
export function parseSamsungEvent(raw: string, encodedName: string, savedCredential?: string): SamsungEvent {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { invalid(); }
  const envelope = record(parsed);
  const event = text(envelope.event);
  if (event === 'ms.channel.unauthorized') return { event: 'unauthorized' };
  if (event === 'ms.channel.timeOut') return { event: 'timeout' };
  if (event === 'ms.error') return { event: 'error' };
  if (event !== 'ms.channel.connect') return { event: 'other' };
  const data = record(envelope.data);
  const id = text(data.id);
  if (!Array.isArray(data.clients)) invalid();
  const clients = data.clients.map((value) => {
    const client = record(value);
    text(client.id); text(client.deviceName);
    if (typeof client.isHost !== 'boolean' || typeof client.connectTime !== 'number' || !Number.isFinite(client.connectTime)) invalid();
    const attributes = record(client.attributes);
    // Validate identifying values without retaining them beyond this boundary.
    if (attributes.name !== null && typeof attributes.name !== 'string') invalid();
    return { id: client.id, name: attributes.name };
  });
  const own = clients.filter((client) => client.id === id);
  // Fresh sample established the boolean type, not an isHost value rule.
  if (own.length !== 1 || own[0]!.name !== encodedName) invalid();
  // Saved-token reuse is an explicit compatibility contract; only fresh pairing
  // was physically sampled. Missing token never authorizes an initial pairing.
  const credential = data.token === undefined ? text(savedCredential) : text(data.token);
  return { event: 'connect', credential };
}
