import { describe, expect, test } from 'vitest';

import { apiErrorSchema, setupStatusSchema } from '@remote-webos-tv/contracts';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const config: AppConfig = {
  dataDir: '/synthetic/data',
  host: '127.0.0.1',
  port: 8080,
  publicOrigin: 'https://remote.example.test',
  secureCookies: true,
  trustedProxy: [],
};

describe('API boundary', () => {
  test.each(['claimed', 'unclaimed'] as const)('returns injected %s setup state', async (state) => {
    const app = buildApp({ config, getSetupState: async () => state });
    try {
      const response = await app.inject('/api/setup/status');
      expect(response.statusCode).toBe(200);
      expect(setupStatusSchema.parse(response.json())).toEqual({ state });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });

  test('does not honor untrusted request IDs or foreign Origin', async () => {
    const app = buildApp({ config, getSetupState: async () => 'unclaimed' });
    try {
      const response = await app.inject({
        url: '/api/setup/status',
        headers: { origin: 'https://foreign.example.test', 'request-id': 'injected-id', 'x-request-id': 'injected-id' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.headers['x-request-id']).not.toBe('injected-id');
    } finally {
      await app.close();
    }
  });

  test('ignores forwarded host and address when proxy is not trusted', async () => {
    const app = buildApp({ config, getSetupState: async () => 'unclaimed' });
    app.get('/api/proxy-check', async (request) => ({ hostname: request.hostname, ip: request.ip }));
    try {
      const response = await app.inject({
        url: '/api/proxy-check',
        headers: { host: 'remote.example.test', 'x-forwarded-host': 'foreign.example.test', 'x-forwarded-for': '192.0.2.2' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ hostname: 'remote.example.test', ip: '127.0.0.1' });
    } finally {
      await app.close();
    }
  });

  test('returns safe errors with generated IDs and no-store for failures and 404', async () => {
    const reports: unknown[] = [];
    const app = buildApp({
      config,
      getSetupState: async () => { throw new Error('private path /synthetic/data and secret'); },
      reportError: (report) => { reports.push(report); },
    });
    try {
      const failed = await app.inject({ url: '/api/setup/status', headers: { 'request-id': 'injected-id' } });
      expect(failed.statusCode).toBe(500);
      expect(failed.headers['cache-control']).toBe('no-store');
      expect(apiErrorSchema.parse(failed.json())).toEqual({
        code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: failed.headers['x-request-id'],
      });
      expect(failed.body).not.toMatch(/secret|synthetic|stack|injected-id/);
      expect(reports).toEqual([{
        requestId: failed.headers['x-request-id'],
        status: 500,
        causeTypes: ['Error'],
      }]);
      expect(JSON.stringify(reports)).not.toMatch(/secret|synthetic|private/);

      const missing = await app.inject('/api/missing');
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['cache-control']).toBe('no-store');
      expect(apiErrorSchema.safeParse(missing.json()).success).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('rejects bodies larger than 16 KiB with a safe no-store response', async () => {
    const app = buildApp({ config, getSetupState: async () => 'unclaimed' });
    app.post('/api/body-check', async () => ({ ok: true }));
    try {
      const response = await app.inject({ method: 'POST', url: '/api/body-check', payload: { body: 'a'.repeat(16 * 1024) } });
      expect(response.statusCode).toBe(413);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(apiErrorSchema.parse(response.json()).code).toBe('PAYLOAD_TOO_LARGE');
    } finally {
      await app.close();
    }
  });

  test('enforces no-store when a future API route sets a cache header', async () => {
    const app = buildApp({ config, getSetupState: async () => 'unclaimed' });
    app.get('/api/future', async (_request, reply) => {
      reply.header('cache-control', 'public, max-age=3600');
      return { ok: true };
    });
    try {
      const response = await app.inject('/api/future');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });

  test('health reflects storage provider and is independent of TV state', async () => {
    const healthy = buildApp({ config, getSetupState: async () => 'unclaimed' });
    const reports: unknown[] = [];
    const unhealthy = buildApp({
      config,
      getSetupState: async () => { throw new Error('storage unavailable'); },
      reportError: (report) => { reports.push(report); },
    });
    try {
      expect((await healthy.inject('/api/health')).statusCode).toBe(200);
      const response = await unhealthy.inject('/api/health');
      expect(response.statusCode).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(apiErrorSchema.parse(response.json()).code).toBe('STORAGE_UNAVAILABLE');
      expect(reports).toEqual([{
        requestId: response.headers['x-request-id'],
        status: 503,
        causeTypes: ['StorageUnavailableError', 'Error'],
      }]);
    } finally {
      await healthy.close();
      await unhealthy.close();
    }
  });
});
