import { Writable } from 'node:stream';

import { expect, test } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { safeListenTextResolver } from '../src/security/logging.js';

const config: AppConfig = {
  dataDir: '/synthetic/private-database', host: '127.0.0.1', port: 8080,
  publicOrigin: 'https://remote.example.test', secureCookies: true, trustedProxy: [],
};

test('request and nested error logs expose only safe diagnostics', async () => {
  const chunks: string[] = [];
  const logStream = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } });
  const app = buildApp({ config, getSetupState: async () => 'unclaimed', logStream });
  app.post('/api/log-failure', async () => {
    throw new Error('private-path /synthetic/private-database', {
      cause: new TypeError('nested-password-secret'),
    });
  });
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/log-failure?token=query-secret',
      headers: {
        authorization: 'Bearer authorization-secret', cookie: 'session=cookie-secret',
        'x-csrf-token': 'csrf-secret', 'content-type': 'application/json',
      },
      payload: { password: 'body-password-secret', token: 'body-token-secret' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: response.headers['x-request-id'] });
    const output = chunks.join('');
    expect(output).toContain('INTERNAL_ERROR');
    expect(output).toContain('TypeError');
    expect(output).toContain(String(response.headers['x-request-id']));
    expect(output).not.toMatch(/query-secret|authorization-secret|cookie-secret|csrf-secret|body-password-secret|body-token-secret|private-database|nested-password-secret|\/api\/log-failure\?/);
  } finally { await app.close(); }
});

test('startup log does not expose the listening address', async () => {
  const chunks: string[] = [];
  const logStream = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } });
  const app = buildApp({ config, getSetupState: async () => 'unclaimed', logStream });
  try {
    await app.listen({ host: '127.0.0.1', port: 0, listenTextResolver: safeListenTextResolver });
    const output = chunks.join('');
    expect(output).toContain('API listening');
    expect(output).not.toMatch(/127\.0\.0\.1|http:\/\//);
  } finally { await app.close(); }
});
