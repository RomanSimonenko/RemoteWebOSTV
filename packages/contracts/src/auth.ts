import { z } from 'zod';

export const setupStateSchema = z.enum(['unclaimed', 'claimed']);
export type SetupState = z.infer<typeof setupStateSchema>;

export const setupStatusSchema = z.strictObject({
  state: setupStateSchema,
});
export type SetupStatus = Readonly<z.infer<typeof setupStatusSchema>>;

const usernameSchema = z.string().refine((value) => [...value].length >= 1 && [...value].length <= 64);
const passwordSchema = z.string().refine((value) => [...value].length >= 12 && [...value].length <= 128);

export const setupRequestSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  username: usernameSchema,
  password: passwordSchema,
});
export type SetupRequest = Readonly<z.infer<typeof setupRequestSchema>>;

export const loginRequestSchema = z.strictObject({
  username: usernameSchema,
  password: passwordSchema,
});
export type LoginRequest = Readonly<z.infer<typeof loginRequestSchema>>;

export const loginResponseSchema = z.strictObject({ username: z.string() });
export type LoginResponse = Readonly<z.infer<typeof loginResponseSchema>>;

export const sessionResponseSchema = z.strictObject({
  username: z.string(),
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type SessionResponse = Readonly<z.infer<typeof sessionResponseSchema>>;

export const apiErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().min(1),
});
export type ApiError = Readonly<z.infer<typeof apiErrorSchema>>;
