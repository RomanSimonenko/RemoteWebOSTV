import { describe, expect, test } from 'vitest';

import {
  tvConnectionStateSchema,
  tvIdentitySchema,
  tvSnapshotSchema,
} from '../src/tv.js';

const capabilities = {
  ssap: true,
  pointer: true,
  powerOff: true,
  wakeOnLan: false,
  apps: true,
  inputs: true,
  textInput: true,
  notifications: true,
};

describe('tv contracts', () => {
  test.each([
    'unconfigured',
    'pairing',
    'connecting',
    'available',
    'unavailable',
    'reconnecting',
    'authorization_error',
    'compatibility_error',
  ] as const)('accepts the documented connection state %s', (state) => {
    expect(tvConnectionStateSchema.parse(state)).toBe(state);
  });

  test('rejects an unknown connection state', () => {
    expect(tvConnectionStateSchema.safeParse('connected').success).toBe(false);
  });

  test('accepts identity without optional firmware fields', () => {
    expect(tvIdentitySchema.parse({ model: 'LG 43UP76906LE' })).toEqual({
      model: 'LG 43UP76906LE',
    });
  });

  test.each(['', '   '])('rejects an empty model %j', (model) => {
    expect(tvIdentitySchema.safeParse({ model }).success).toBe(false);
  });

  test.each([-1, 101, 10.5])('rejects invalid volume %s', (volume) => {
    expect(
      tvSnapshotSchema.safeParse({
        connection: 'available',
        capabilities,
        volume,
      }).success,
    ).toBe(false);
  });

  test('accepts volume boundaries', () => {
    expect(
      tvSnapshotSchema.parse({
        connection: 'available',
        capabilities,
        volume: 0,
      }).volume,
    ).toBe(0);
    expect(
      tvSnapshotSchema.parse({
        connection: 'available',
        capabilities,
        volume: 100,
      }).volume,
    ).toBe(100);
  });

  test('rejects an unknown transport', () => {
    expect(
      tvSnapshotSchema.safeParse({
        connection: 'available',
        capabilities,
        transport: 'http:80',
      }).success,
    ).toBe(false);
  });

  test('preserves buttons without pointer and the Tizen secure transport', () => {
    expect(tvSnapshotSchema.parse({
      connection: 'available', capabilities: { ...capabilities, buttons: true, pointer: false }, transport: 'wss:8002',
    })).toMatchObject({ capabilities: { buttons: true, pointer: false }, transport: 'wss:8002' });
  });

  test('strips address and authorization fields at the public boundary', () => {
    const parsed = tvSnapshotSchema.parse({
      connection: 'available',
      capabilities,
      transport: 'wss:3001',
      ipAddress: '192.0.2.10',
      macAddress: '02:00:00:00:00:01',
      clientKey: 'synthetic-client-key',
    });

    expect(parsed).toEqual({
      connection: 'available',
      capabilities,
      transport: 'wss:3001',
    });
  });
});
