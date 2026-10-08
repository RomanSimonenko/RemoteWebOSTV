import { expect, test } from 'vitest';
import * as contracts from '../src/index.js';

const id = '15e082b2-de7e-4d86-a049-19c7448264f1';
const operation = { id, action: 'wake', status: 'running', phase: 'connecting', delivery: 'sent', startedAt: 1000, deadlineAt: 61000 };
const state = { mac: null, canPowerOff: false, canWake: false, operation: null };

test('exports the power contract schemas', () => {
  expect(contracts.tvPowerRequestSchema).toBeDefined();
  expect(contracts.tvPowerOperationSchema).toBeDefined();
  expect(contracts.tvPowerStateSchema).toBeDefined();
  expect(contracts.tvMacAddressSchema).toBeDefined();
});

test('accepts explicit power-off confirmation and wake without confirmation', () => {
  expect(contracts.tvPowerRequestSchema.parse({ id, action: 'power_off', confirm: true })).toEqual({ id, action: 'power_off', confirm: true });
  expect(contracts.tvPowerRequestSchema.parse({ id, action: 'wake' })).toEqual({ id, action: 'wake' });
});

test.each([
  { id, action: 'power_off' }, { id, action: 'power_off', confirm: false },
  { id, action: 'wake', confirm: true }, { id, action: 'recover' },
  { id: 'invalid', action: 'wake' }, { id, action: 'wake', extra: true },
])('rejects invalid power request %j', (input) => {
  expect(contracts.tvPowerRequestSchema.safeParse(input).success).toBe(false);
});

test.each(['02:ab:cd:ef:00:01', '02-ab-cd-ef-00-01'])('normalizes unicast MAC %s', (mac) => {
  expect(contracts.tvMacAddressSchema.parse(mac)).toBe('02:AB:CD:EF:00:01');
  expect(contracts.tvPowerStateSchema.parse({ ...state, mac }).mac).toBe('02:AB:CD:EF:00:01');
});

test.each(['', ' ', '020000000001', '02:00:00:00:00', '02:00:00:00:00:gg', '01:00:00:00:00:01', 'FF:FF:FF:FF:FF:FF', '00:00:00:00:00:00'])('rejects unsafe or malformed MAC %j', (mac) => {
  expect(contracts.tvMacAddressSchema.safeParse(mac).success).toBe(false);
  expect(contracts.tvPowerStateSchema.safeParse({ ...state, mac }).success).toBe(false);
});

test('accepts explicit null MAC and requires all power state fields', () => {
  expect(contracts.tvPowerStateSchema.parse(state)).toEqual(state);
  expect(contracts.tvPowerStateSchema.safeParse({ canPowerOff: false, canWake: false, operation: null }).success).toBe(false);
  expect(contracts.tvPowerStateSchema.safeParse({ ...state, extra: true }).success).toBe(false);
  expect(contracts.tvPowerStateSchema.safeParse({ ...state, wakeSupported: 'false' }).success).toBe(false);
});
test.each([true, false])('accepts an explicit wake support discriminator %s', (wakeSupported) => {
  expect(contracts.tvPowerStateSchema.parse({ ...state, wakeSupported })).toEqual({ ...state, wakeSupported });
});

test.each(['power_off', 'wake', 'recover'])('accepts operation action %s', (action) => {
  expect(contracts.tvPowerOperationSchema.parse({ ...operation, action })).toEqual({ ...operation, action });
});

test.each([
  { id: 'invalid' }, { startedAt: -1 }, { startedAt: 0.5 }, { startedAt: Number.POSITIVE_INFINITY },
  { deadlineAt: 1000 }, { deadlineAt: 999 }, { deadlineAt: 8_640_000_000_000_001 },
  { action: 'pair' }, { status: 'done' }, { phase: 'waiting' }, { delivery: 'delivered' },
  { extra: true }, { error: { code: '', message: 'error' } },
  { error: { code: 'ERROR', message: ' ' } }, { error: { code: 'x'.repeat(65), message: 'error' } },
  { error: { code: 'ERROR', message: 'x'.repeat(1025) } }, { error: { code: 'ERROR', message: 'error', secret: true } },
])('rejects invalid power operation %j', (change) => {
  expect(contracts.tvPowerOperationSchema.safeParse({ ...operation, ...change }).success).toBe(false);
});

test('validates nested operation and trims public errors', () => {
  const value = { ...operation, status: 'failed', phase: 'finished', error: { code: ' ERROR ', message: ' Safe message ' } };
  expect(contracts.tvPowerStateSchema.parse({ ...state, operation: value }).operation?.error).toEqual({ code: 'ERROR', message: 'Safe message' });
  expect(contracts.tvPowerStateSchema.safeParse({ ...state, operation: { ...operation, extra: true } }).success).toBe(false);
});
