import { z } from 'zod';
import { publicTvErrorSchema, timestampSchema } from './tv-setup.js';

export const tvMacAddressSchema = z.string()
  .regex(/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i)
  .transform((mac) => mac.replaceAll('-', ':').toUpperCase())
  .refine((mac) => (Number.parseInt(mac.slice(0, 2), 16) & 1) === 0 && mac !== '00:00:00:00:00:00', {
    message: 'Expected a nonzero unicast MAC address',
  });

export const tvPowerRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ id: z.uuid(), action: z.literal('power_off'), confirm: z.literal(true) }),
  z.strictObject({ id: z.uuid(), action: z.literal('wake') }),
]);
export type TvPowerRequest = Readonly<z.infer<typeof tvPowerRequestSchema>>;

export const tvPowerOperationSchema = z.strictObject({
  id: z.uuid(),
  action: z.enum(['power_off', 'wake', 'recover']),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  phase: z.enum(['sending', 'connecting', 'finished']),
  delivery: z.enum(['not_sent', 'sent', 'unknown']),
  startedAt: timestampSchema,
  deadlineAt: timestampSchema,
  error: publicTvErrorSchema.optional(),
}).refine((operation) => operation.deadlineAt > operation.startedAt, {
  message: 'Operation deadline must be after its start',
  path: ['deadlineAt'],
});
export type TvPowerOperation = Readonly<z.infer<typeof tvPowerOperationSchema>>;

export const tvPowerStateSchema = z.strictObject({
  busy: z.boolean().optional(),
  mac: tvMacAddressSchema.nullable(),
  canPowerOff: z.boolean(),
  canWake: z.boolean(),
  wakeSupported: z.boolean().optional(),
  operation: tvPowerOperationSchema.nullable(),
});
export type TvPowerState = Readonly<z.infer<typeof tvPowerStateSchema>>;
