import { z } from 'zod';

const nonEmptyTextSchema = z.string().trim().min(1);

export const tvPlatformSchema = z.enum(['webos', 'tizen']);
export type TvPlatform = z.infer<typeof tvPlatformSchema>;

export const tvConnectionStateSchema = z.enum([
  'unconfigured',
  'pairing',
  'connecting',
  'available',
  'unavailable',
  'reconnecting',
  'authorization_error',
  'compatibility_error',
]);

export type TvConnectionState = z.infer<typeof tvConnectionStateSchema>;

export const tvTransportSchema = z.enum(['wss:3001', 'ws:3000', 'wss:8002']);

export type TvTransport = z.infer<typeof tvTransportSchema>;

export const tvIdentitySchema = z.object({
  model: nonEmptyTextSchema,
  platformVersion: nonEmptyTextSchema.optional(),
  firmwareVersion: nonEmptyTextSchema.optional(),
});

export type TvIdentity = Readonly<z.infer<typeof tvIdentitySchema>>;

// Availability starts from the adapter's supported profile and is downgraded
// when the active TV rejects a capability-owned endpoint as unsupported.
export const tvCapabilitiesSchema = z.object({
  ssap: z.boolean(),
  // Optional for legacy webOS payloads. Explicit false overrides pointer.
  buttons: z.boolean().optional(),
  pointer: z.boolean(),
  powerOff: z.boolean(),
  wakeOnLan: z.boolean(),
  apps: z.boolean(),
  inputs: z.boolean(),
  textInput: z.boolean(),
  notifications: z.boolean(),
});

export type TvCapabilities = Readonly<z.infer<typeof tvCapabilitiesSchema>>;

export function supportsTvButtons(capabilities: TvCapabilities): boolean {
  return (capabilities.buttons ?? capabilities.pointer) === true;
}

export const tvAppSchema = z.object({
  id: nonEmptyTextSchema,
  name: nonEmptyTextSchema,
});

export type TvApp = Readonly<z.infer<typeof tvAppSchema>>;

export const tvInputSchema = z.object({
  id: nonEmptyTextSchema,
  label: nonEmptyTextSchema,
  connected: z.boolean().optional(),
});

export type TvInput = Readonly<z.infer<typeof tvInputSchema>>;

export const tvButtonSchema = z.enum([
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'ENTER',
  'HOME',
  'BACK',
  'EXIT',
  'MENU',
  'VOLUME_UP',
  'VOLUME_DOWN',
  'MUTE',
  'CHANNEL_UP',
  'CHANNEL_DOWN',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'RED',
  'GREEN',
  'YELLOW',
  'BLUE',
  'PLAY',
  'PAUSE',
  'STOP',
  'REWIND',
  'FAST_FORWARD',
]);

export type TvButton = z.infer<typeof tvButtonSchema>;

export const tvSnapshotSchema = z.object({
  connection: tvConnectionStateSchema,
  identity: tvIdentitySchema.optional(),
  capabilities: tvCapabilitiesSchema,
  transport: tvTransportSchema.optional(),
  volume: z.number().int().min(0).max(100).optional(),
  muted: z.boolean().optional(),
  foregroundAppId: nonEmptyTextSchema.optional(),
  inputId: nonEmptyTextSchema.optional(),
});

export type TvSnapshot = Readonly<z.infer<typeof tvSnapshotSchema>>;
