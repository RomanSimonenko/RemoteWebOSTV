import { describe, expect, test } from 'vitest';

import {
  apiErrorSchema,
  loginRequestSchema,
  loginResponseSchema,
  sessionResponseSchema,
  setupRequestSchema,
  setupStatusSchema,
} from '../src/index.js';

describe('auth API contracts', () => {
  test.each(['unclaimed', 'claimed'] as const)('accepts %s setup state', (state) => {
    expect(setupStatusSchema.parse({ state })).toEqual({ state });
  });

  test('rejects unknown setup state and extra fields', () => {
    expect(setupStatusSchema.safeParse({ state: 'pending' }).success).toBe(false);
    expect(setupStatusSchema.safeParse({ state: 'claimed', ownerId: 'private' }).success).toBe(false);
  });

  test('accepts only a safe error shape', () => {
    expect(apiErrorSchema.parse({ code: 'INTERNAL_ERROR', message: 'Internal error', requestId: 'req-1' })).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal error',
      requestId: 'req-1',
    });
    expect(apiErrorSchema.safeParse({ code: 'INTERNAL_ERROR', message: 'Internal error', requestId: 'req-1', stack: 'private' }).success).toBe(false);
    expect(apiErrorSchema.safeParse({ code: 'INTERNAL_ERROR', message: 'Internal error' }).success).toBe(false);
  });

  test('auth inputs and responses reject extra private fields', () => {
    expect(setupRequestSchema.safeParse({ token: 'A'.repeat(43), username: 'alice', password: 'long-password-123', role: 'admin' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ username: 'alice', password: 'long-password-123', sessionToken: 'private' }).success).toBe(false);
    expect(loginResponseSchema.safeParse({ username: 'alice', token: 'private' }).success).toBe(false);
    expect(sessionResponseSchema.safeParse({ username: 'alice', csrfToken: 'A'.repeat(43), masterKey: 'private' }).success).toBe(false);
  });

  test('request length limits count Unicode characters like owner setup validation', () => {
    expect(setupRequestSchema.safeParse({ token: 'A'.repeat(43), username: '😀'.repeat(64), password: '😀'.repeat(12) }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ username: '😀'.repeat(65), password: 'long-password-123' }).success).toBe(false);
  });
});
