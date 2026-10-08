import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { expect, test as base, type Page } from '@playwright/test';
import type { TvStatusResponse } from '../../../../packages/contracts/src/index.js';
import { Lgtv2Adapter, createLgtv2Client } from '../../../../packages/webos/dist/src/index.js';
import { MockWebOsTv, type MockScenario } from '../../../../packages/webos/test/support/mock-webos-tv.js';
import { mockClientKey } from '../../../../packages/webos/test/support/fixtures.js';
import { createSamsungAdapter } from '../../../../packages/tizen/dist/src/index.js';
import { ControlledSocket, identitySample, connectSample } from '../../../../packages/tizen/test/support/mock-samsung.js';
import { createApiRuntime } from '../../../api/dist/src/runtime.js';
import { runSetupTokenCli } from '../../../api/dist/src/auth/cli.js';
import { formatStartupError } from '../../../api/dist/src/startup-errors.js';
import type { TvScheduler } from '../../../api/src/tv/service.js';

const webRoot = fileURLToPath(new URL('../../dist/', import.meta.url));
export const tvHost = '192.168.50.20';
export const failedHost = '192.168.50.21';
export const secondHost = '192.168.50.22';
export const samsungHost = '192.168.50.23';
const password = 'synthetic browser acceptance password';

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

class Clock implements TvScheduler {
  time = 0;
  #next = 0;
  #timers = new Map<number, { at: number; run: () => void }>();
  now = () => this.time;
  setTimeout(run: () => void, delayMs: number): unknown {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.time + delayMs, run });
    return id;
  }
  clearTimeout(id: unknown) { this.#timers.delete(id as number); }
  get pendingCount() { return this.#timers.size; }
  get nextDelay() { return Math.min(...[...this.#timers.values()].map((timer) => timer.at - this.time)); }
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at <= this.time) { this.#timers.delete(id); timer.run(); }
    }
  }
}

async function availablePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

export class TvFixture {
  readonly clock = new Clock();
  readonly promptGate = gate();
  readonly policies: Array<{ host: string; prompt: boolean }> = [];
  readonly wakes: Array<{ macs: readonly string[]; signal: AbortSignal }> = [];
  readonly samsungSockets: ControlledSocket[] = [];
  readonly samsungConnections: Array<{ prompted: boolean }> = [];
  #wakeGate: ReturnType<typeof gate> | undefined;
  readonly #mocks: MockWebOsTv[] = [];
  readonly #logs: string[] = [];
  #directory = '';
  #origin = '';
  #setupToken = '';
  #app: Awaited<ReturnType<typeof createApiRuntime>> | undefined;
  #tv!: MockWebOsTv;
  #secondTv: MockWebOsTv | undefined;
  #lastTvId: string | undefined;
  #offlineUrl = '';
  #unavailable: Server | undefined;
  #tvUnavailable = false;
  #epoch = Date.now();
  #id = 0;
  get origin() { return this.#origin; }
  get tv() { return this.#tv; }
  get secondTv() { if (!this.#secondTv) throw new Error('Second fixture TV is not enabled'); return this.#secondTv; }
  get tvPath() { return this.#lastTvId ? `/api/tvs/${this.#lastTvId}` : '/api/tv'; }
  async enableSecondTv() { this.#secondTv = await this.#startMock({ kind: 'success' }); }
  get unavailablePort() { return Number(new URL(this.#offlineUrl).port); }
  get promptCount() { return this.#mocks.reduce((count, mock) => count + mock.pairingPromptCount, 0); }
  holdWake() { this.#wakeGate = gate(); return this.#wakeGate; }

  async start() {
    this.#directory = await mkdtemp(join(tmpdir(), 'remote-webos-tv-browser-'));
    const diagnostics: string[] = [];
    const exitCode = await runSetupTokenCli({
      args: ['setup-token'], env: { REMOTE_WEBOS_DATA_DIR: join(this.#directory, 'data') },
      stdout: (token) => { this.#setupToken = token; }, stderr: (line) => { diagnostics.push(line); },
    });
    // The built CLI owns safe diagnostic projection; never expose child-process stderr.
    if (exitCode !== 0) throw new Error(`Synthetic setup-token CLI failed (exit=${exitCode}): ${diagnostics.join('; ')}`);
    if (!/^[A-Za-z0-9_-]{43}$/.test(this.#setupToken)) throw new Error('Invalid synthetic setup token');
    this.#origin = `http://127.0.0.1:${await availablePort()}`;
    await this.replaceTv({ kind: 'deferred-pairing', gate: this.promptGate.promise });
    // Own the endpoint until teardown. Both TLS and WebSocket handshakes fail
    // deterministically; another listener cannot turn this target into a TV.
    const unavailable = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      unavailable.once('error', reject);
      unavailable.listen(0, '127.0.0.1', resolve);
    });
    this.#unavailable = unavailable;
    this.#offlineUrl = `ws://127.0.0.1:${(unavailable.address() as AddressInfo).port}`;
    await this.#startApi();
  }

  async #startMock(scenario: MockScenario) {
    const mock = new MockWebOsTv({ scenario });
    this.#mocks.push(mock);
    await mock.start();
    return mock;
  }

  async replaceTv(scenario: MockScenario) {
    await this.#tv?.stop();
    this.#tv = await this.#startMock(scenario);
    this.#tvUnavailable = false;
  }

  async makeTvUnavailable() {
    this.#tvUnavailable = true;
    await this.#tv.stop();
  }

  async #startApi() {
    const config = {
      dataDir: join(this.#directory, 'data'), host: '127.0.0.1', port: Number(new URL(this.origin).port),
      publicOrigin: this.origin, secureCookies: false, trustedProxy: [],
    };
    try {
      this.#app = await createApiRuntime(config, {
        webRoot, scheduler: this.clock, now: () => this.#epoch + this.clock.time,
        newId: () => `00000000-0000-4000-8000-${String(++this.#id).padStart(12, '0')}`,
        logStream: new Writable({ write: (chunk, _encoding, done) => { this.#logs.push(String(chunk)); done(); } }),
        createAdapter: (host, keyStore, requestTimeoutMs, allowPairingPrompt, platform = 'webos') => {
          if (platform === 'tizen') {
            if (host !== samsungHost) throw new Error('Unmapped synthetic Samsung address');
            this.policies.push({ host, prompt: allowPairingPrompt });
            return createSamsungAdapter({ host, requestTimeoutMs, handshakeTimeoutMs: requestTimeoutMs, allowPairingPrompt, scheduler: this.clock,
              requestIdentity: async () => identitySample,
              createSocket: (url) => {
                const socket = new ControlledSocket();
                this.samsungSockets.push(socket);
                this.samsungConnections.push({ prompted: !new URL(url).searchParams.has('token') });
                queueMicrotask(() => { socket.open(); socket.message(connectSample()); });
                return socket;
              },
            });
          }
          // Mapping is confined to this fixture: public validation and HTTP security remain real.
          if (host !== tvHost && host !== failedHost && !(host === secondHost && this.#secondTv)) throw new Error('Unmapped synthetic TV address');
          this.policies.push({ host, prompt: allowPairingPrompt });
          const url = host === secondHost && this.#secondTv ? this.#secondTv.url : host === tvHost && !this.#tvUnavailable ? this.#tv.url : this.#offlineUrl;
          const port = Number(new URL(url).port);
          return new Lgtv2Adapter({ host, keyStore, requestTimeoutMs, handshakeTimeoutMs: requestTimeoutMs,
            allowPairingPrompt, now: () => new Date(this.#epoch + this.clock.time) }, {
            // Only the external WOL transport is replaced; adapter/service/API remain real.
            // Actual UDP delivery has a separate loopback integration test.
            wake: async (macs, signal) => {
              this.wakes.push({ macs: [...macs], signal });
              if (!this.#wakeGate) return;
              await new Promise<void>((resolve, reject) => {
                const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) { abort(); return; }
                void this.#wakeGate!.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
              });
            },
            createClient: (options) => createLgtv2Client({ ...options, host: '127.0.0.1',
              ports: { secure: port, insecure: port }, verifyCert: false }),
          });
        },
      });
      await this.#app.listen({ host: config.host, port: config.port });
    } catch (error) { throw new Error(formatStartupError(error)); }
  }

  async restart() {
    await this.#app?.close();
    this.#app = undefined;
    await this.#startApi();
  }

  async setupAndLogin(page: Page) {
    page.on('response', async (response) => {
      if (response.url() === `${this.origin}/api/tvs` && response.request().method() === 'POST' && response.status() === 202) {
        this.#lastTvId = (await response.json() as { tvId: string }).tvId;
      }
    });
    await page.goto(this.origin);
    await page.getByLabel('Установочный токен').fill(this.#setupToken);
    await page.getByLabel('Имя владельца').fill('synthetic-owner');
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Создать владельца' }).click();
    await this.login(page);
  }

  async login(page: Page) {
    await expect(page.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
    await page.getByLabel('Логин').fill('synthetic-owner');
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
  }

  async status(page: Page): Promise<TvStatusResponse> {
    let response = await page.context().request.get(`${this.origin}${this.tvPath}`);
    // A failed draft is intentionally not persisted across API restart.
    if (response.status() === 404) response = await page.context().request.get(`${this.origin}/api/tv`);
    if (!response.ok()) throw new Error(`TV fixture status failed (${response.status()})`);
    return response.json();
  }

  async expireUnavailableRecovery(page: Page) {
    await this.status(page); // Observe the disconnect and start its single bounded cycle.
    await expect.poll(() => this.clock.nextDelay).toBe(1000);
    this.clock.advance(60_000);
    await expect.poll(async () => (await this.status(page)).error?.code).toBe('RECOVERY_TIMEOUT');
    await expect.poll(() => this.clock.pendingCount).toBe(0);
  }

  async hasExposedSecrets(text: string) {
    const masters = await Promise.all(['auth-master.key', 'tv-master.key'].map((name) => readFile(join(this.#directory, 'data', name))));
    return [mockClientKey, this.#setupToken, password, ...masters.flatMap((key) => [key.toString('hex'), key.toString('base64'), key.toString('base64url')])]
      .some((secret) => text.includes(secret));
  }

  async logsHaveSecrets() { return this.hasExposedSecrets(this.#logs.join('')); }

  async close() {
    this.promptGate.release();
    this.#wakeGate?.release();
    try { await this.#app?.close(); }
    finally {
      const unavailable = this.#unavailable;
      this.#unavailable = undefined;
      try {
        await Promise.all([
          ...this.#mocks.map((mock) => mock.stop()),
          ...(unavailable ? [new Promise<void>((resolve, reject) => {
            unavailable.close((error) => error ? reject(error) : resolve());
          })] : []),
        ]);
      }
      finally {
        this.samsungSockets.forEach(socket => socket.terminate());
        if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
      }
    }
  }
}

export const test = base.extend<{ tv: TvFixture }>({
  tv: async ({}, use) => {
    const tv = new TvFixture();
    try { await tv.start(); await use(tv); }
    finally { await tv.close(); }
  },
});
