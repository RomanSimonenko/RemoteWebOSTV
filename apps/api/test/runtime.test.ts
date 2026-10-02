import { mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { createApiRuntime, serveApi } from '../src/runtime.js';
import { createOwnerRepository } from '../src/auth/repository.js';
import { createOwnerSetupService } from '../src/auth/service.js';
import { openDatabase } from '../src/storage/database.js';

test('startup setup status follows the persisted owner after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-runtime-'));
  const config: AppConfig = {
    dataDir: join(directory, 'data'), host: '127.0.0.1', port: 8080,
    publicOrigin: 'https://remote.example.test', secureCookies: true, trustedProxy: [],
  };
  try {
    const first = await createApiRuntime(config);
    expect((await first.inject('/api/setup/status')).json()).toEqual({ state: 'unclaimed' });
    await first.close();

    const database = await openDatabase({ dataDir: config.dataDir });
    try {
      const service = createOwnerSetupService({ repository: createOwnerRepository(database.sqlite) });
      const token = await service.issueSetupToken();
      await service.claimOwner({ token, username: 'alice', password: 'correct horse battery staple' });
    } finally { database.close(); }

    const second = await createApiRuntime(config);
    try {
      expect((await second.inject('/api/setup/status')).json()).toEqual({ state: 'claimed' });
    } finally { await second.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed HTTP listen closes the runtime and removes signal handlers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-listen-failure-'));
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  const config: AppConfig = {
    dataDir: join(directory, 'data'), host: '127.0.0.1', port: (occupied.address() as AddressInfo).port,
    publicOrigin: 'http://127.0.0.1', secureCookies: false, trustedProxy: [],
  };
  const signals = new EventEmitter();
  try {
    const app = await createApiRuntime(config);
    await expect(serveApi(app, config, signals)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    await expect(app.inject('/api/setup/status')).rejects.toThrow();
    const restarted = await createApiRuntime(config);
    try {
      expect((await restarted.inject('/api/setup/status')).json()).toEqual({ state: 'unclaimed' });
    } finally { await restarted.close(); }
  } finally {
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(['SIGINT', 'SIGTERM'] as const)('%s closes HTTP and SQLite while preserving a completed claim', async (signal) => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-webos-shutdown-'));
  const config: AppConfig = {
    dataDir: join(directory, 'data'), host: '127.0.0.1', port: 0,
    publicOrigin: 'http://127.0.0.1', secureCookies: false, trustedProxy: [],
  };
  const signals = new EventEmitter();
  const app = await createApiRuntime(config);
  try {
    const closed = new Promise<void>((resolve) => app.addHook('onClose', async () => resolve()));
    const address = await serveApi(app, config, signals);
    const database = await openDatabase({ dataDir: config.dataDir });
    let token: string;
    try {
      token = await createOwnerSetupService({ repository: createOwnerRepository(database.sqlite) }).issueSetupToken();
    } finally { database.close(); }
    const claim = await fetch(`${address}/api/setup`, {
      method: 'POST', headers: { origin: config.publicOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ token, username: 'alice', password: 'correct horse battery staple' }),
    });
    expect(claim.status).toBe(201);
    signals.emit(signal);
    await closed;
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    await expect(app.inject('/api/setup/status')).rejects.toThrow();
    const restarted = await createApiRuntime(config);
    try {
      expect((await restarted.inject('/api/setup/status')).json()).toEqual({ state: 'claimed' });
    } finally { await restarted.close(); }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed signal shutdown reports safe cause types and sets a failing exit code', async () => {
  const output: string[] = [];
  const logStream = new Writable({ write(chunk, _encoding, done) { output.push(String(chunk)); done(); } });
  const config: AppConfig = {
    dataDir: '/synthetic/private-data', host: '127.0.0.1', port: 0,
    publicOrigin: 'http://127.0.0.1', secureCookies: false, trustedProxy: [],
  };
  const app = buildApp({ config, getSetupState: async () => 'unclaimed', logStream });
  const signals = new EventEmitter();
  const exitCodeBefore = process.exitCode;
  const failure = new TypeError('private-path /synthetic/private-data', { cause: new Error('secret-value') });
  const close = vi.spyOn(app, 'close').mockRejectedValueOnce(failure);
  try {
    await serveApi(app, config, signals);
    signals.emit('SIGTERM');
    await Promise.resolve();
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(process.exitCode).toBe(1);
    const diagnostic = output.join('');
    expect(diagnostic).toContain('API_SHUTDOWN_FAILED');
    expect(diagnostic).toContain('TypeError');
    expect(diagnostic).toContain('"Error"');
    expect(diagnostic).not.toMatch(/private-path|private-data|secret-value/);
  } finally {
    close.mockRestore();
    process.exitCode = exitCodeBefore;
    await app.close();
  }
});
