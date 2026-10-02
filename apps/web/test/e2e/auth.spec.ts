import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const runFile = promisify(execFile);
const apiEntry = fileURLToPath(new URL('../../../api/dist/src/index.js', import.meta.url));
const tokenEntry = fileURLToPath(new URL('../../../api/dist/src/auth/cli.js', import.meta.url));
const password = 'correct horse battery staple';

let directory: string;
let origin: string;
let setupToken: string;
let apiProcess: ChildProcess;

async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForListening(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let tail = '';
    const timeout = setTimeout(() => finish(new Error('API did not start')), 15_000);
    const output = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-200);
      if (tail.includes('API listening')) finish();
    };
    const exited = () => finish(new Error('API exited before listening'));
    const spawnFailed = () => finish(new Error('API process could not start'));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout?.off('data', output);
      child.off('exit', exited);
      child.off('error', spawnFailed);
      child.stdout?.resume();
      error ? reject(error) : resolve();
    };
    child.stdout?.on('data', output);
    child.stderr?.resume();
    child.once('exit', exited);
    child.once('error', spawnFailed);
  });
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'remote-webos-browser-'));
  const dataDir = join(directory, 'data');
  const { stdout } = await runFile(process.execPath, [tokenEntry, 'setup-token'], {
    env: { REMOTE_WEBOS_DATA_DIR: dataDir },
  });
  setupToken = stdout.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(setupToken)) throw new Error('CLI did not return a valid setup token');
  origin = `http://127.0.0.1:${await availablePort()}`;
  apiProcess = spawn(process.execPath, [apiEntry], {
    env: {
      REMOTE_WEBOS_DATA_DIR: dataDir,
      REMOTE_WEBOS_HOST: '127.0.0.1',
      REMOTE_WEBOS_PORT: new URL(origin).port,
      REMOTE_WEBOS_PUBLIC_ORIGIN: origin,
      REMOTE_WEBOS_SECURE_COOKIES: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForListening(apiProcess);
});

test.afterAll(async () => {
  if (apiProcess?.pid && apiProcess.exitCode === null && apiProcess.signalCode === null) {
    const stopped = once(apiProcess, 'exit');
    apiProcess.kill('SIGTERM');
    await stopped;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('CLI token claims one owner and browser session survives reload until logout', async ({ page }) => {
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Первичная настройка' })).toBeVisible();
  await page.getByLabel('Установочный токен').fill(setupToken);
  await page.getByLabel('Имя владельца').fill('alice');
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Создать владельца' }).click();
  await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();

  const secondClaim = await page.context().request.post(`${origin}/api/setup`, {
    headers: { origin }, data: { token: setupToken, username: 'bob', password },
  });
  expect(secondClaim.status()).toBe(403);

  await page.getByLabel('Имя владельца').fill('alice');
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Телевизор ещё не настроен' })).toBeVisible();

  const cookies = await page.context().cookies(origin);
  const cookie = cookies.find(({ name }) => name === 'remote_webos_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  const session = await page.context().request.get(`${origin}/api/auth/session`);
  expect(session.status()).toBe(200);
  const identity = await session.json() as { username: string; csrfToken: string };
  expect(identity.username).toBe('alice');
  expect(Object.keys(identity).sort()).toEqual(['csrfToken', 'username']);
  expect(typeof identity.csrfToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(identity.csrfToken)).toBe(true);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Телевизор ещё не настроен' })).toBeVisible();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

  const rejectedOrigin = await page.context().request.post(`${origin}/api/auth/logout`, {
    headers: { origin: 'https://foreign.example.test', 'x-csrf-token': identity.csrfToken },
  });
  expect(rejectedOrigin.status()).toBe(403);
  const rejectedCsrf = await page.context().request.post(`${origin}/api/auth/logout`, { headers: { origin } });
  expect(rejectedCsrf.status()).toBe(403);
  expect((await page.context().request.get(`${origin}/api/auth/session`)).status()).toBe(200);

  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();
  expect((await page.context().request.get(`${origin}/api/auth/session`)).status()).toBe(401);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});
