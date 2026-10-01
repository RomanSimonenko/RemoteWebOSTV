import { z } from 'zod';

export const setupStateSchema = z.enum(['unclaimed', 'claimed']);
export type SetupState = z.infer<typeof setupStateSchema>;

export const setupStatusSchema = z.strictObject({
  state: setupStateSchema,
});
export type SetupStatus = Readonly<z.infer<typeof setupStatusSchema>>;

export const apiErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().min(1),
});
export type ApiError = Readonly<z.infer<typeof apiErrorSchema>>;
