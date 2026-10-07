import { expect, test } from 'vitest';
import * as contracts from '../src/index.js';

const tvId = '00000000-0000-4000-8000-000000000001';
const request = { id: tvId, platform: 'webos', host: '10.2.3.4' };
const status = { tv: { host: '10.2.3.4', identity: { model: 'Synthetic TV' } }, connection: 'available', operation: null };

test('acceptsCanonicalWebosDevice', () => {
  expect(contracts).toHaveProperty('tvDevicesResponseSchema');
  expect(contracts.tvDevicesResponseSchema.parse({ devices: [{ tvId, platform: 'webos', status }] })).toEqual({ devices: [{ tvId, platform: 'webos', status }] });
  expect(contracts.addTvRequestSchema.parse({ ...request, host: ' 10.2.3.4 ' })).toEqual(request);
  expect(contracts.tvDevicesResponseSchema.parse({ devices: [] })).toEqual({ devices: [] });
  expect(contracts.addTvResponseSchema.parse({ tvId, operation: { id: 'synthetic-operation', action: 'pair', status: 'running', startedAt: 0, deadlineAt: 1 } })).toEqual({ tvId, operation: { id: 'synthetic-operation', action: 'pair', status: 'running', startedAt: 0, deadlineAt: 1 } });
});

test('rejectsTizenAndUnknownFields', () => {
  expect(contracts).toHaveProperty('addTvRequestSchema');
  expect(contracts.addTvRequestSchema.safeParse({ ...request, platform: 'tizen' }).success).toBe(false);
  expect(contracts.addTvRequestSchema.safeParse({ ...request, port: 3000 }).success).toBe(false);
});

test('rejectsInvalidIdAndNonPrivateHost', () => {
  expect(contracts).toHaveProperty('tvIdSchema');
  for (const id of ['', 'not-an-id', null, 0]) expect(contracts.tvIdSchema.safeParse(id).success).toBe(false);
  for (const host of ['', 'example.test', '8.8.8.8', '10.2.3.256']) expect(contracts.addTvRequestSchema.safeParse({ ...request, host }).success).toBe(false);
});

test('rejectsSecretFields', () => {
  expect(contracts).toHaveProperty('tvDevicesResponseSchema');
  expect(contracts.tvDevicesResponseSchema.safeParse({ devices: [{ tvId, platform: 'webos', status, encryptedClientKey: 'synthetic' }] }).success).toBe(false);
  expect(contracts.tvDevicesResponseSchema.safeParse({ devices: [{ tvId, platform: 'webos', status: { ...status, tv: { ...status.tv, clientKey: 'synthetic' } } }] }).success).toBe(false);
});
