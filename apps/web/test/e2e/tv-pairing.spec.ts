import { expect, type Page } from '@playwright/test';
import { createServer } from 'node:net';
import { test, gate, tvHost, failedHost, type TvFixture } from '../support/tv-fixture.js';

async function competingBind(port: number) {
  const server = createServer();
  const result = await new Promise<string>((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'unknown'));
    server.listen(port, '127.0.0.1', () => resolve('listening'));
  });
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return result;
}

async function startPair(page: Page, tv: TvFixture) {
  await expect(page.getByRole('button', { name: 'Подключить', exact: true })).toBeVisible();
  await page.getByLabel('IP-адрес телевизора').fill(tvHost);
  const accepted = page.waitForResponse((response) => response.url() === `${tv.origin}/api/tv/operations` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  expect((await accepted).status()).toBe(202);
  await tv.tv.waitForRequestCount(1);
  await expect(page.getByText('Подтвердите доступ на экране телевизора.')).toBeVisible();
}

async function savedTv(page: Page) {
  await expect(page.getByRole('heading', { name: 'Телевизор', exact: true })).toBeVisible();
  await expect(page.getByText('43UP76906LE', { exact: true })).toBeVisible();
  await expect(page.getByText(tvHost, { exact: true })).toBeVisible();
}

async function pairSuccessfully(page: Page, tv: TvFixture) {
  await tv.setupAndLogin(page);
  await startPair(page, tv);
  expect((await tv.status(page)).tv).toBeNull();
  tv.promptGate.release();
  await savedTv(page);
  await expect(page.getByRole('status')).toHaveText('Подключён');
}

test('saved TV survives browser reload, logout/login and API restart without a new prompt or exposed secrets', async ({ page, tv }) => {
  const browserLogs: string[] = [];
  page.on('console', (message) => browserLogs.push(message.text()));
  page.on('pageerror', (error) => browserLogs.push(error.message));
  await pairSuccessfully(page, tv);
  expect(tv.promptCount).toBe(1);
  const first = await tv.status(page);
  expect(first.operation?.status).toBe('succeeded');
  expect(Object.keys(first).sort()).toEqual(['connection', 'operation', 'tv']);
  expect(Object.keys(first.tv!).sort()).toEqual(['host', 'identity']);
  expect(Object.keys(first.tv!.identity).sort()).toEqual(['firmwareVersion', 'model', 'platformVersion']);
  expect(Object.keys(first.operation!).sort()).toEqual(['action', 'deadlineAt', 'id', 'startedAt', 'status']);
  expect(await tv.hasExposedSecrets(JSON.stringify(first))).toBe(false);

  await page.reload();
  await savedTv(page);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect((await page.context().request.get(`${tv.origin}/api/tv`)).status()).toBe(401);
  await tv.login(page);
  await savedTv(page);
  expect(tv.promptCount).toBe(1);

  await tv.replaceTv({ kind: 'success' });
  await tv.restart();
  await page.reload();
  await savedTv(page);
  await expect(page.getByRole('status')).toHaveText('Подключён');
  expect((await tv.status(page)).tv).toEqual(first.tv);
  expect(tv.promptCount).toBe(1);
  expect(tv.policies).toEqual([{ host: tvHost, prompt: true }, { host: tvHost, prompt: false }]);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(await tv.hasExposedSecrets(await page.locator('body').innerText())).toBe(false);
  expect(await tv.hasExposedSecrets(page.url())).toBe(false);
  expect(await tv.hasExposedSecrets(browserLogs.join(''))).toBe(false);
  expect(await tv.logsHaveSecrets()).toBe(false);
});

test('reload preserves the server pair deadline and timeout cannot save a late approval', async ({ page, tv }) => {
  await tv.setupAndLogin(page);
  await startPair(page, tv);
  const running = (await tv.status(page)).operation!;
  expect(running.deadlineAt - running.startedAt).toBe(60_000);
  tv.clock.advance(40_000);
  await page.clock.setFixedTime(running.startedAt + 40_000);
  await page.reload();
  await expect(page.getByText('Подтвердите доступ на экране телевизора.')).toBeVisible();
  await expect(page.getByText('Осталось: 20 с', { exact: true })).toBeVisible();
  expect((await tv.status(page)).operation).toEqual(running);
  expect(tv.promptCount).toBe(1);
  tv.clock.advance(20_000);
  await expect.poll(async () => (await tv.status(page)).operation?.error?.code).toBe('PAIRING_TIMEOUT');
  await expect(page.getByRole('alert')).toHaveText('Время ожидания сопряжения истекло.');
  await tv.tv.waitForActiveSocketCount(0);
  tv.promptGate.release();
  await tv.restart();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Подключить', exact: true })).toBeVisible();
  expect((await tv.status(page)).tv).toBeNull();
});

test('TV rejection is visible and leaves no saved TV', async ({ page, tv }) => {
  await tv.replaceTv({ kind: 'reject-pairing' });
  await tv.setupAndLogin(page);
  await page.getByLabel('IP-адрес телевизора').fill(tvHost);
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Запрос на сопряжение отклонён.');
  const status = await tv.status(page);
  expect(status.tv).toBeNull();
  expect(status.operation?.error?.code).toBe('PAIRING_REJECTED');
  expect(await tv.hasExposedSecrets(JSON.stringify(status))).toBe(false);
});

test('cancel closes the prompt connection and a late TV approval cannot configure it', async ({ page, tv }) => {
  await tv.setupAndLogin(page);
  await startPair(page, tv);
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Операция отменена.');
  await tv.tv.waitForActiveSocketCount(0);
  tv.promptGate.release();
  await tv.restart();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Подключить', exact: true })).toBeVisible();
  const status = await tv.status(page);
  expect(status.tv).toBeNull();
  expect(status.operation).toBeNull();
});

test('unavailable TV and failed address change keep the saved identity through restart', async ({ page, tv }) => {
  await pairSuccessfully(page, tv);
  const original = (await tv.status(page)).tv;
  expect(await competingBind(tv.unavailablePort)).toBe('EADDRINUSE');
  await tv.makeTvUnavailable();
  await expect.poll(async () => (await tv.status(page)).connection).toBe('unavailable');
  await expect(page.getByRole('status')).toHaveText('Нет соединения');
  await savedTv(page);

  await page.getByLabel('IP-адрес телевизора').fill(failedHost);
  await page.getByRole('button', { name: 'Изменить адрес', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Телевизор недоступен по сети.');
  expect((await tv.status(page)).tv).toEqual(original);
  expect(tv.policies.at(-1)).toEqual({ host: failedHost, prompt: false });
  await tv.restart();
  await page.reload();
  await savedTv(page);
  await expect(page.getByRole('status')).toHaveText('Нет соединения');
  expect((await tv.status(page)).tv).toEqual(original);
  expect(tv.promptCount).toBe(1);
  expect(await competingBind(tv.unavailablePort)).toBe('EADDRINUSE');
  expect(tv.policies.at(-1)).toEqual({ host: tvHost, prompt: false });
  await tv.close();
  expect(await competingBind(tv.unavailablePort)).toBe('listening');
});

test('revoked saved key requires explicit repair and reload never starts another prompt', async ({ page, tv }) => {
  await pairSuccessfully(page, tv);
  const original = (await tv.status(page)).tv;
  await tv.replaceTv({ kind: 'reject-pairing' });
  await tv.restart();
  await page.reload();
  await savedTv(page);
  await expect(page.getByRole('status')).toHaveText('Ошибка авторизации');
  await expect(page.getByRole('alert')).toHaveText('Телевизор не принял сохранённую авторизацию.');
  expect((await tv.status(page)).tv).toEqual(original);
  expect(tv.promptCount).toBe(1);
  expect(tv.policies.at(-1)).toEqual({ host: tvHost, prompt: false });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Ошибка авторизации');
  expect(tv.policies).toHaveLength(2);

  const permission = gate();
  await tv.replaceTv({ kind: 'deferred-pairing', gate: permission.promise });
  try {
    await page.getByRole('button', { name: 'Повторить сопряжение', exact: true }).click();
    await tv.tv.waitForRequestCount(1);
    await expect(page.getByText('Подтвердите доступ на экране телевизора.')).toBeVisible();
    expect(tv.policies.at(-1)).toEqual({ host: tvHost, prompt: true });
    permission.release();
    await expect(page.getByRole('status')).toHaveText('Подключён');
    expect((await tv.status(page)).tv).toEqual(original);
    expect(tv.promptCount).toBe(2);
  } finally { permission.release(); }
});

test('a delayed accepted operation in one tab yields to a fresh operation completed in another tab', async ({ page, context, tv }) => {
  await tv.setupAndLogin(page);
  await expect(page.getByRole('button', { name: 'Подключить', exact: true })).toBeVisible();
  const accepted = gate();
  const deliver = gate();
  const readFresh = gate();
  // Stop tab A from observing its original operation while its POST response is held.
  await page.route(`${tv.origin}/api/tv`, async (route) => {
    await readFresh.promise;
    await route.continue();
  });
  await page.route(`${tv.origin}/api/tv/operations`, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    accepted.release();
    await deliver.promise;
    await route.fulfill({ response });
  });
  const second = await context.newPage();
  try {
    await page.getByLabel('IP-адрес телевизора').fill(tvHost);
    await page.getByRole('button', { name: 'Подключить', exact: true }).click();
    await accepted.promise;
    const firstId = (await tv.status(page)).operation!.id;
    await second.goto(tv.origin);
    await second.getByRole('button', { name: 'Отменить', exact: true }).click();
    await tv.tv.waitForActiveSocketCount(0);
    await expect(second.getByRole('button', { name: 'Подключить', exact: true })).toBeVisible();
    await second.getByLabel('IP-адрес телевизора').fill(tvHost);
    await second.getByRole('button', { name: 'Подключить', exact: true }).click();
    await tv.tv.waitForRequestCount(2);
    await second.getByRole('button', { name: 'Отменить', exact: true }).click();
    await tv.tv.waitForActiveSocketCount(0);
    const latest = (await tv.status(second)).operation!;
    expect(latest.id).not.toBe(firstId);
    expect(latest.status).toBe('cancelled');
    deliver.release();
    await expect(page.getByRole('button', { name: 'Отменить', exact: true })).toBeVisible();
    readFresh.release();
    await expect(page.getByRole('button', { name: 'Подключить', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Отменить', exact: true })).toBeHidden();
  } finally { deliver.release(); readFresh.release(); await second.close(); }
});
