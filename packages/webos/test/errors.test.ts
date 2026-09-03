import { describe, expect, test } from 'vitest';

import { WebOsError } from '../src/errors.js';

describe('WebOsError', () => {
  test('preserves the internal cause for server-side diagnostics', () => {
    const cause = new Error('connect ECONNREFUSED 192.0.2.10:3001');
    const error = new WebOsError(
      'NETWORK_UNREACHABLE',
      'Connection to wss://192.0.2.10:3001 failed',
      { cause },
    );

    expect(error.cause).toBe(cause);
    expect(error.code).toBe('NETWORK_UNREACHABLE');
  });

  test('exposes only allowlisted fields in a public diagnostic', () => {
    const error = new WebOsError(
      'AUTHORIZATION_FAILED',
      'Rejected client-key synthetic-client-key at /private/tmp/key-file',
      {
        cause: new Error(
          'TV 192.0.2.10 with MAC 02:00:00:00:00:01 rejected the key',
        ),
      },
    );

    const diagnostic = error.toSafeDiagnostic('operation-123');
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic.code).toBe('AUTHORIZATION_FAILED');
    expect(diagnostic.operationId).toBe('operation-123');
    expect(diagnostic.message.length).toBeGreaterThan(0);
    expect(Object.keys(diagnostic).sort()).toEqual([
      'code',
      'message',
      'operationId',
    ]);
    expect(serialized).not.toContain('192.0.2.10');
    expect(serialized).not.toContain('02:00:00:00:00:01');
    expect(serialized).not.toContain('synthetic-client-key');
    expect(serialized).not.toContain('/private/tmp');
    expect(serialized).not.toContain('stack');
  });

  test('omits operationId when none is supplied', () => {
    const diagnostic = new WebOsError(
      'UNSUPPORTED_CAPABILITY',
      'Pointer socket is unavailable',
    ).toSafeDiagnostic();

    expect(diagnostic).not.toHaveProperty('operationId');
  });
});
