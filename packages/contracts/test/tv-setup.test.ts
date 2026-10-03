import { describe, expect, test } from 'vitest';

import * as contracts from '../src/index.js';

const schemas = contracts;

const operation = {
  id: 'synthetic-operation', action: 'pair', status: 'running',
  startedAt: 1_800_000_000_000, deadlineAt: 1_800_000_060_000,
};
const status = {
  tv: { host: '192.168.42.10', identity: { model: 'Synthetic TV' } },
  connection: 'available', operation,
};

describe('TV setup public contracts', () => {
  test('exports the setup schemas at the public package boundary', () => {
    expect(schemas.startTvOperationSchema).toBeDefined();
    expect(schemas.tvOperationSchema).toBeDefined();
    expect(schemas.tvStatusResponseSchema).toBeDefined();
  });

  test.each([
    '10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255',
    '192.168.0.0', '192.168.255.255', '192.168.42.0', '192.168.42.255',
  ])('accepts valid local IPv4 %s without guessing a subnet mask', (host) => {
    expect(schemas.startTvOperationSchema.parse({ action: 'pair', host })).toEqual({ action: 'pair', host });
  });

  test('trims surrounding address whitespace', () => {
    expect(schemas.startTvOperationSchema.parse({ action: 'pair', host: ' 10.2.3.4 ' })).toEqual({ action: 'pair', host: '10.2.3.4' });
  });

  test.each([
    'http://10.2.3.4', 'ws://10.2.3.4:3000', 'tv.local', 'localhost', '10.2.3.4:3000',
    '9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255',
    '192.169.0.0', '127.0.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '169.254.1.2', '100.64.0.1', '192.0.2.10', '::1', '::ffff:10.2.3.4',
    '', ' ', '10.2.3', '10.2.3.4.5', '10.2.3.256', '10.-1.3.4', '10.2.3.1.5',
    '010.2.3.4', '10.02.3.4', '10.2.3.004', '0x0a.2.3.4', '167904004', '10.2. 3.4',
  ])('rejects URL hostname port non-private or malformed target %j', (host) => {
    expect(schemas.startTvOperationSchema.safeParse({ action: 'pair', host }).success).toBe(false);
  });

  test.each(['pair', 'change_address'])('%s requires its host', (action) => {
    expect(schemas.startTvOperationSchema.safeParse({ action }).success).toBe(false);
    expect(schemas.startTvOperationSchema.safeParse({ action, host: '10.2.3.4' }).success).toBe(true);
  });

  test.each(['reconnect', 'repair'])('%s forbids any host field', (action) => {
    expect(schemas.startTvOperationSchema.parse({ action })).toEqual({ action });
    for (const host of ['10.2.3.4', undefined, null]) {
      expect(schemas.startTvOperationSchema.safeParse({ action, host }).success).toBe(false);
    }
  });

  test.each([null, {}, { action: 'discover' }, { action: 'pair', host: 123 }, { action: 'pair', host: '10.2.3.4', port: 3000 }])('rejects malformed or extra request fields %j', (input) => {
    expect(schemas.startTvOperationSchema.safeParse(input).success).toBe(false);
  });

  test.each(['running', 'succeeded', 'failed', 'cancelled'])('accepts operation status %s', (value) => {
    expect(schemas.tvOperationSchema.safeParse({ ...operation, status: value }).success).toBe(true);
  });

  test('accepts bounded safe error codes added by the service', () => {
    expect(schemas.tvOperationSchema.parse({ ...operation, status: 'failed', error: { code: 'OPERATION_CONFLICT', message: 'Another operation is running.' } })).toEqual({ ...operation, status: 'failed', error: { code: 'OPERATION_CONFLICT', message: 'Another operation is running.' } });
  });

  test.each([
    { id: '' }, { id: 'x'.repeat(129) }, { action: 'discover' }, { status: 'pending' },
    { startedAt: -1 }, { startedAt: 0.5 }, { startedAt: Number.NaN },
    { deadlineAt: Number.POSITIVE_INFINITY }, { deadlineAt: 8_640_000_000_000_001 },
    { deadlineAt: 1_800_000_000_000 }, { deadlineAt: 1_799_999_999_999 },
    { error: { code: '', message: 'Failure' } }, { error: { code: ' ', message: 'Failure' } },
    { error: { code: 'x'.repeat(65), message: 'Failure' } },
    { error: { code: 'FAILURE', message: '' } }, { error: { code: 'FAILURE', message: ' ' } },
    { error: { code: 'FAILURE', message: 'x'.repeat(1025) } },
  ])('rejects invalid operation metadata %j', (patch) => {
    expect(schemas.tvOperationSchema.safeParse({ ...operation, ...patch }).success).toBe(false);
  });

  test('accepts timestamp endpoints with a positive deadline interval', () => {
    expect(schemas.tvOperationSchema.safeParse({ ...operation, startedAt: 0, deadlineAt: 1 }).success).toBe(true);
    expect(schemas.tvOperationSchema.safeParse({ ...operation, startedAt: 8_639_999_999_999_999, deadlineAt: 8_640_000_000_000_000 }).success).toBe(true);
  });

  test('accepts configured and unconfigured public status', () => {
    expect(schemas.tvStatusResponseSchema.parse(status)).toEqual(status);
    expect(schemas.tvStatusResponseSchema.parse({ tv: null, connection: 'unconfigured', operation: null })).toEqual({ tv: null, connection: 'unconfigured', operation: null });
  });

  test.each(['clientKey', 'ciphertext', 'masterKey', 'macAddress'])('public response rejects secret or private field %s at every nested object', (field) => {
    const secret = { [field]: 'synthetic-value' };
    for (const value of [
      { ...status, ...secret },
      { ...status, tv: { ...status.tv, ...secret } },
      { ...status, tv: { ...status.tv, identity: { ...status.tv.identity, ...secret } } },
      { ...status, operation: { ...operation, ...secret } },
      { ...status, operation: { ...operation, error: { code: 'FAILURE', message: 'Safe failure', ...secret } } },
      { ...status, error: { code: 'FAILURE', message: 'Safe failure', ...secret } },
    ]) expect(schemas.tvStatusResponseSchema.safeParse(value).success).toBe(false);
  });

  test.each([
    { tv: { ...status.tv, host: '192.0.2.10' } }, { tv: { ...status.tv, identity: { model: '' } } },
    { connection: 'connected' }, { operation: undefined }, { tv: undefined },
    { error: { code: '', message: 'Failure' } },
  ])('rejects malformed public status %j', (patch) => {
    expect(schemas.tvStatusResponseSchema.safeParse({ ...status, ...patch }).success).toBe(false);
  });
});
