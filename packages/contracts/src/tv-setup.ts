import { z } from 'zod';

import { tvConnectionStateSchema, tvIdentitySchema, type TvIdentity } from './tv.js';
import { tvMacAddressSchema } from './tv-mac.js';

export const localTvHostSchema = z.string().trim().refine((host) => {
  if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(host)) return false;
  const octets = host.split('.').map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets;
  return first === 10
    || (first === 172 && second! >= 16 && second! <= 31)
    || (first === 192 && second === 168);
}, { message: 'Expected a literal private RFC1918 IPv4 address' });

export const tvActionSchema = z.enum(['pair', 'reconnect', 'change_address', 'repair']);
export type TvAction = z.infer<typeof tvActionSchema>;

export const publicTvErrorSchema = z.strictObject({
  code: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1).max(1024),
});
type PublicTvError = Readonly<z.infer<typeof publicTvErrorSchema>>;

// Epoch milliseconds must be precisely representable and valid for JS Date.
export const timestampSchema = z.number().int().min(0).max(8_640_000_000_000_000);

export const tvOperationSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  action: tvActionSchema,
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  startedAt: timestampSchema,
  deadlineAt: timestampSchema,
  error: publicTvErrorSchema.optional(),
}).refine((operation) => operation.deadlineAt > operation.startedAt, {
  message: 'Operation deadline must be after its start',
  path: ['deadlineAt'],
});
export type TvOperation = Readonly<Omit<z.infer<typeof tvOperationSchema>, 'error'> & {
  error?: PublicTvError;
}>;

export const savedTvViewSchema = z.strictObject({
  host: localTvHostSchema,
  // Tighten only this public boundary; the adapter's producer contract is unchanged.
  identity: tvIdentitySchema.strict(),
});
export type SavedTvView = Readonly<Omit<z.infer<typeof savedTvViewSchema>, 'identity'> & {
  identity: TvIdentity;
}>;

export const tvStatusResponseSchema = z.strictObject({
  tv: savedTvViewSchema.nullable(),
  connection: tvConnectionStateSchema,
  operation: tvOperationSchema.nullable(),
  error: publicTvErrorSchema.optional(),
});
export type TvStatusResponse = Readonly<Omit<z.infer<typeof tvStatusResponseSchema>, 'tv' | 'operation' | 'error'> & {
  tv: SavedTvView | null;
  operation: TvOperation | null;
  error?: PublicTvError;
}>;

export const startTvOperationSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('pair'), host: localTvHostSchema, mac: tvMacAddressSchema.optional() }),
  z.strictObject({ action: z.literal('change_address'), host: localTvHostSchema }),
  z.strictObject({ action: z.literal('reconnect') }),
  z.strictObject({ action: z.literal('repair') }),
]);
export type StartTvOperation = Readonly<z.infer<typeof startTvOperationSchema>>;
