import { describe, expect, test } from 'vitest';

import {
  basicTvButtonSchema,
  tvCommandRequestSchema,
  tvCommandResultSchema,
  tvRemoteStateSchema,
} from '../src/index.js';

const id = '123e4567-e89b-42d3-a456-426614174000';

describe('basic remote command contracts', () => {
  test.each([
    'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'HOME',
    'VOLUME_UP', 'VOLUME_DOWN', 'MUTE',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    'CHANNEL_DOWN', 'CHANNEL_UP', 'RED', 'GREEN', 'YELLOW', 'BLUE',
  ])('accepts basic button %s', (button) => {
    expect(basicTvButtonSchema.parse(button)).toBe(button);
    expect(tvCommandRequestSchema.parse({ id, button })).toEqual({ id, button });
  });

  test.each([
    'EXIT', 'MENU', 'PLAY',
    'LIST', 'GUIDE', 'INPUT', 'UNKNOWN', '', 'up',
    null, 0,
  ])('rejects excluded button %j', (button) => {
    expect(basicTvButtonSchema.safeParse(button).success).toBe(false);
    expect(tvCommandRequestSchema.safeParse({ id, button }).success).toBe(false);
  });

  test.each([undefined, null, '', 'command-1', '123e4567-e89b-42d3-a456', 1])(
    'requires a UUID command id: %j', (invalidId) => {
      expect(tvCommandRequestSchema.safeParse({ id: invalidId, button: 'UP' }).success).toBe(false);
      expect(tvCommandResultSchema.safeParse({ id: invalidId, outcome: 'sent' }).success).toBe(false);
    },
  );

  test('rejects extra request fields', () => {
    expect(tvCommandRequestSchema.safeParse({ id, button: 'UP', uri: 'synthetic-uri' }).success).toBe(false);
  });

  test('accepts sent without an error', () => {
    expect(tvCommandResultSchema.parse({ id, outcome: 'sent' })).toEqual({ id, outcome: 'sent' });
  });

  test.each([
    'TV_UNAVAILABLE', 'TV_BUSY', 'UNSUPPORTED_CAPABILITY', 'COMMAND_NOT_SENT', 'RATE_LIMITED',
  ])('accepts rejected with %s', (code) => {
    const result = { id, outcome: 'rejected', error: { code, message: 'Command was not sent' } };
    expect(tvCommandResultSchema.parse(result)).toEqual(result);
  });

  test('accepts unknown only with COMMAND_RESULT_UNKNOWN', () => {
    const result = { id, outcome: 'unknown', error: { code: 'COMMAND_RESULT_UNKNOWN', message: 'Result is unknown' } };
    expect(tvCommandResultSchema.parse(result)).toEqual(result);
  });

  test.each([
    { id, outcome: 'sent', error: { code: 'TV_BUSY', message: 'Busy' } },
    { id, outcome: 'sent', error: undefined },
    { id, outcome: 'rejected' },
    { id, outcome: 'unknown' },
    { id, outcome: 'rejected', error: { code: 'COMMAND_RESULT_UNKNOWN', message: 'Unknown' } },
    ...['TV_UNAVAILABLE', 'TV_BUSY', 'UNSUPPORTED_CAPABILITY', 'COMMAND_NOT_SENT', 'RATE_LIMITED'].map((code) => (
      { id, outcome: 'unknown', error: { code, message: 'Wrong classification' } }
    )),
    ...['BAD_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED', 'OTHER'].map((code) => (
      { id, outcome: 'rejected', error: { code, message: 'Not a command error' } }
    )),
    { id, outcome: 'rejected', error: { code: 'TV_BUSY', message: '' } },
    { id, outcome: 'rejected', error: { code: 'TV_BUSY', message: '   ' } },
    { id, outcome: 'rejected', error: { code: 'TV_BUSY', message: 'x'.repeat(1025) } },
    { id, outcome: 'rejected', error: { code: 'TV_BUSY', message: 'Busy', cause: 'private detail' } },
    { id, outcome: 'unknown', error: { code: 'COMMAND_RESULT_UNKNOWN', message: 'Unknown', cause: 'private detail' } },
    { id, outcome: 'sent', clientKey: 'synthetic-key' },
    { id, outcome: 'rejected', error: { code: 'TV_BUSY', message: 'Busy' }, host: 'synthetic-host' },
    { id, outcome: 'unknown', error: { code: 'COMMAND_RESULT_UNKNOWN', message: 'Unknown' }, host: 'synthetic-host' },
    { id, outcome: 'other' },
  ])('rejects invalid result %#', (result) => {
    expect(tvCommandResultSchema.safeParse(result).success).toBe(false);
  });

  test.each([
    { enabled: true, reason: null },
    { enabled: true, reason: null, apps: false },
    { enabled: true, reason: null, apps: true },
    { enabled: false, reason: 'UNAVAILABLE' },
    { enabled: false, reason: 'BUSY' },
    { enabled: false, reason: 'UNSUPPORTED' },
  ])('accepts consistent remote state %j', (state) => {
    expect(tvRemoteStateSchema.parse(state)).toEqual(state);
  });

  test.each([
    { enabled: false, reason: null },
    { enabled: true, reason: 'UNAVAILABLE' },
    { enabled: true, reason: 'BUSY' },
    { enabled: true, reason: 'UNSUPPORTED' },
    { enabled: false, reason: 'OTHER' },
    { enabled: false },
    { reason: null },
    { enabled: true, reason: null, host: 'synthetic-host' },
    { enabled: true, reason: null, apps: 'false' },
    { enabled: false, reason: 'BUSY', operation: 'synthetic-operation' },
  ])('rejects invalid remote state %j', (state) => {
    expect(tvRemoteStateSchema.safeParse(state).success).toBe(false);
  });
});

test('accepts only an exclusive Wink launch request', () => {
  expect(tvCommandRequestSchema.parse({ id, app: 'wink' })).toEqual({ id, app: 'wink' });
  for (const value of [{ id, app: 'other' }, { id, app: 'wink', button: 'HOME' }, { id, app: 'wink', appId: 'arbitrary' }]) expect(tvCommandRequestSchema.safeParse(value).success).toBe(false);
});
