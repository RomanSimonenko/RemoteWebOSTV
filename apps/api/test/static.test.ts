import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { apiErrorSchema } from '@remote-webos-tv/contracts';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { createApiRuntime } from '../src/runtime.js';

const directories: string[] = [];
const config: AppConfig = {
  dataDir: '/synthetic/data', host: '127.0.0.1', port: 8080,
  publicOrigin: 'http://127.0.0.1:8080', secureCookies: false, trustedProxy: [],
};

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test('serves built assets and limits SPA fallback to GET HTML navigation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-webos-static-'));
  directories.push(root);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>UI marker</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'const marker = 1;');
  const app = buildApp({ config, getSetupState: async () => 'unclaimed', webRoot: root });
  try {
    const asset = await app.inject('/assets/app.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.body).toContain('marker');

    const navigation = await app.inject({ url: '/settings', headers: { accept: 'text/html' } });
    expect(navigation.statusCode).toBe(200);
    expect(navigation.headers['content-type']).toMatch(/text\/html/);
    expect(navigation.body).toContain('UI marker');

    for (const options of [
      { method: 'POST' as const, url: '/settings', headers: { accept: 'text/html' } },
      { method: 'GET' as const, url: '/settings', headers: { accept: 'application/json' } },
      { method: 'GET' as const, url: '/missing.js', headers: { accept: 'text/html' } },
      { method: 'GET' as const, url: '/api/missing', headers: { accept: 'text/html' } },
    ]) {
      const missing = await app.inject(options);
      expect(missing.statusCode).toBe(404);
      expect(apiErrorSchema.parse(missing.json()).code).toBe('NOT_FOUND');
      if (options.url.startsWith('/api/')) expect(missing.headers['cache-control']).toBe('no-store');
    }
  } finally { await app.close(); }
});

test('unknown API paths stay JSON 404 with production authentication enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-webos-static-auth-'));
  directories.push(root);
  await writeFile(join(root, 'index.html'), '<!doctype html><title>UI marker</title>');
  const app = await createApiRuntime({ ...config, dataDir: join(root, 'data') }, { webRoot: root });
  try {
    for (const options of [
      { method: 'GET' as const, url: '/api/missing', headers: { accept: 'text/html' } },
      { method: 'POST' as const, url: '/api/missing', headers: { accept: 'text/html' } },
    ]) {
      const missing = await app.inject(options);
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['content-type']).toMatch(/application\/json/);
      expect(missing.headers['cache-control']).toBe('no-store');
      expect(apiErrorSchema.parse(missing.json()).code).toBe('NOT_FOUND');
    }
  } finally { await app.close(); }
});
