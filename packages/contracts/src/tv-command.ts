import { z } from 'zod';

export const basicTvButtonSchema = z.enum([
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'ENTER',
  'BACK',
  'HOME',
  'VOLUME_UP',
  'VOLUME_DOWN',
  'MUTE',
]);
export type BasicTvButton = z.infer<typeof basicTvButtonSchema>;

const commandIdSchema = z.uuid();

export const tvCommandRequestSchema = z.strictObject({
  id: commandIdSchema,
  button: basicTvButtonSchema,
});
export type TvCommandRequest = Readonly<z.infer<typeof tvCommandRequestSchema>>;

const commandErrorMessageSchema = z.string().trim().min(1).max(1024);

const rejectedCommandErrorSchema = z.strictObject({
  code: z.enum([
    'TV_UNAVAILABLE',
    'TV_BUSY',
    'UNSUPPORTED_CAPABILITY',
    'COMMAND_NOT_SENT',
    'RATE_LIMITED',
  ]),
  message: commandErrorMessageSchema,
});

const unknownCommandErrorSchema = z.strictObject({
  code: z.literal('COMMAND_RESULT_UNKNOWN'),
  message: commandErrorMessageSchema,
});

export const tvCommandResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ id: commandIdSchema, outcome: z.literal('sent') }),
  z.strictObject({
    id: commandIdSchema,
    outcome: z.literal('rejected'),
    error: rejectedCommandErrorSchema,
  }),
  z.strictObject({
    id: commandIdSchema,
    outcome: z.literal('unknown'),
    error: unknownCommandErrorSchema,
  }),
]);
export type TvCommandResult = Readonly<z.infer<typeof tvCommandResultSchema>>;

export const tvRemoteStateSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(true), reason: z.null() }),
  z.strictObject({
    enabled: z.literal(false),
    reason: z.enum(['UNAVAILABLE', 'BUSY', 'UNSUPPORTED']),
  }),
]);
export type TvRemoteState = Readonly<z.infer<typeof tvRemoteStateSchema>>;
