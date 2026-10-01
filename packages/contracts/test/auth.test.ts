import { describe, expect, test } from 'vitest';

import {
  apiErrorSchema,
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
});
