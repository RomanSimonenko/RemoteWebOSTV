import { expect, type Page } from '@playwright/test';
import type { TvPowerState } from '../../../../packages/contracts/src/index.js';
import { test, tvHost, type TvFixture } from '../support/tv-fixture.js';

const power = (page: Page) => page.getByRole('group', { name: 'Питание телевизора', exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Настройки телевизора', exact: true });
async function openSettings(page: Page) {
  if (!await settings(page).isVisible()) await page.getByRole('button', { name: 'Настройки', exact: true }).click();
}
const off = 'ssap://system/turnOff';
const mac = '02:00:00:00:00:03';
const offRequests = (tv: TvFixture) => tv.tv.requests.filter((request) => request.uri === off);

async function state(page: Page, tv: TvFixture): Promise<TvPowerState> {
  const response = await page.context().request.get(`${tv.origin}/api/tv/power`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function headers(page: Page, tv: TvFixture) {
  const response = await page.context().request.get(`${tv.origin}/api/auth/session`);
  const { csrfToken } = await response.json() as { csrfToken: string };
  return { origin: tv.origin, 'x-csrf-token': csrfToken };
}

async function ready(page: Page) {
  await expect(page.getByRole('status', { name: 'Соединение с телевизором' })).toHaveText('Подключён');
  await expect(power(page).getByRole('button', { name: 'Выключить ТВ', exact: true })).toBeEnabled();
}

async function pair(page: Page, tv: TvFixture) {
  await tv.setupAndLogin(page);
  await page.getByLabel('IP-адрес телевизора').fill(tvHost);
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await tv.tv.waitForRequestCount(1);
  tv.promptGate.release();
  await ready(page);
}

async function saveMac(page: Page) {
  await openSettings(page);
  await settings(page).getByLabel('MAC-адрес телевизора').fill('02-00-00-00-00-03');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/tv/mac') && response.request().method() === 'PUT');
  await settings(page).getByRole('button', { name: 'Сохранить MAC', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(settings(page).getByLabel('MAC-адрес телевизора')).toHaveValue(mac);
  await page.keyboard.press('Escape');
}

async function confirmOff(page: Page) {
  await power(page).getByRole('button', { name: 'Выключить ТВ', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить выключение', exact: true }).click();
}

async function intentionalOff(page: Page, tv: TvFixture) {
  await tv.replaceTv({ kind: 'close-after-response', uri: off });
  await pair(page, tv);
  await saveMac(page);
  await confirmOff(page);
  await expect.poll(async () => (await state(page, tv)).operation?.status).toBe('succeeded');
  await expect(power(page).getByRole('button', { name: 'Включить ТВ', exact: true })).toBeEnabled();
  await tv.makeTvUnavailable();
}

test('cancelled confirmation sends nothing; confirmed power-off sends exact SSAP once and suppresses recovery', async ({ page, tv }) => {
  await tv.replaceTv({ kind: 'close-after-response', uri: off });
  await pair(page, tv);
  await power(page).getByRole('button', { name: 'Выключить ТВ', exact: true }).click();
  await page.getByRole('button', { name: 'Не выключать', exact: true }).click();
  expect(offRequests(tv)).toEqual([]);
  expect((await state(page, tv)).operation).toBeNull();
  await confirmOff(page);
  await expect.poll(async () => (await state(page, tv)).operation?.status).toBe('succeeded');
  expect(offRequests(tv)).toEqual([{ id: expect.any(String), type: 'request', uri: off }]);
  expect((await state(page, tv)).operation).toMatchObject({ action: 'power_off', delivery: 'sent' });
  await expect(page.getByRole('status', { name: 'Питание телевизора', exact: true })).toContainText('фактическое выключение не подтверждено');
  const attempts = tv.policies.length;
  tv.clock.advance(120_000);
  await tv.status(page);
  await page.reload();
  await expect(page.getByRole('status', { name: 'Питание телевизора', exact: true })).toContainText('фактическое выключение не подтверждено');
  expect(tv.policies).toHaveLength(attempts);
  expect(offRequests(tv)).toHaveLength(1);
  expect(tv.wakes).toEqual([]);
});

test('MAC validation and normalization persist in SQLite across restart; cleared MAC prevents WOL', async ({ page, tv }) => {
  await pair(page, tv);
  await openSettings(page);
  await settings(page).getByLabel('MAC-адрес телевизора').fill('00:00:00:00:00:00');
  await settings(page).getByRole('button', { name: 'Сохранить MAC', exact: true }).click();
  await expect(settings(page).getByRole('alert')).toContainText('корректный ненулевой unicast');
  await saveMac(page);
  await tv.replaceTv({ kind: 'success' });
  await tv.restart();
  await page.reload();
  await ready(page);
  expect((await state(page, tv)).mac).toBe(mac);
  await openSettings(page);
  await expect(settings(page).getByLabel('MAC-адрес телевизора')).toHaveValue(mac);
  await settings(page).getByRole('button', { name: 'Очистить MAC', exact: true }).click();
  await expect.poll(async () => (await state(page, tv)).mac).toBeNull();
  await page.keyboard.press('Escape');
  await tv.restart();
  await page.reload();
  await ready(page);
  expect((await state(page, tv)).mac).toBeNull();
  await tv.makeTvUnavailable();
  await tv.status(page);
  tv.clock.advance(60_000);
  await expect.poll(async () => (await state(page, tv)).operation?.status).toBe('failed');
  await expect(power(page).getByRole('button', { name: 'Питание ТВ', exact: true })).toBeDisabled();
  const rejected = await page.context().request.post(`${tv.origin}/api/tv/power`, {
    headers: await headers(page, tv), data: { id: '10000000-0000-4000-8000-000000000001', action: 'wake' },
  });
  expect(rejected.status()).toBe(409);
  expect(await rejected.json()).toMatchObject({ code: 'WOL_NOT_CONFIGURED' });
  expect(tv.wakes).toEqual([]);
  expect(tv.promptCount).toBe(1);
});

test('double click and stale second tab admit one wake; unavailable retry recovers with saved key after reload', async ({ page, context, tv }) => {
  await intentionalOff(page, tv);
  const second = await context.newPage();
  await second.goto(tv.origin);
  await expect(power(second).getByRole('button', { name: 'Включить ТВ', exact: true })).toBeEnabled();
  const wake = tv.holdWake();
  const requests: string[] = [];
  page.on('request', (request) => { if (request.url() === `${tv.origin}/api/tv/power` && request.method() === 'POST') requests.push(request.postData()!); });
  await power(page).getByRole('button', { name: 'Включить ТВ', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => tv.wakes.length).toBe(1);
  const conflict = second.waitForResponse((response) => response.url() === `${tv.origin}/api/tv/power` && response.request().method() === 'POST');
  await power(second).getByRole('button', { name: 'Включить ТВ', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  expect(requests).toHaveLength(1);
  expect(tv.wakes[0]!.macs).toEqual([mac]);
  const acceptedId = (await state(page, tv)).operation!.id;
  await page.reload();
  await expect(page.locator('.tv-activity').getByRole('button', { name: 'Отменить ожидание', exact: true })).toBeVisible();
  expect((await state(page, tv)).operation!.id).toBe(acceptedId);
  wake.release();
  await expect.poll(() => tv.clock.nextDelay).toBe(1000);
  expect((await state(page, tv)).operation).toMatchObject({ status: 'running', delivery: 'sent' });
  await tv.replaceTv({ kind: 'success' });
  tv.clock.advance(1000);
  await ready(page);
  expect((await state(page, tv)).operation).toMatchObject({ id: acceptedId, action: 'wake', status: 'succeeded', delivery: 'sent' });
  expect(tv.wakes).toHaveLength(1);
  expect(tv.promptCount).toBe(1);
  expect(tv.policies.slice(1).every((policy) => !policy.prompt)).toBe(true);
  expect(tv.tv.pointerFrames).toEqual([]);
  expect(offRequests(tv)).toEqual([]);
  expect(await tv.logsHaveSecrets()).toBe(false);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test('unexpected disconnect runs one bounded recovery without WOL or PROMPT and offers no user cancel', async ({ page, tv }) => {
  await pair(page, tv);
  await tv.makeTvUnavailable();
  await tv.status(page);
  await expect.poll(() => tv.clock.nextDelay).toBe(1000);
  await page.reload();
  await expect(page.getByRole('status', { name: 'Питание телевизора', exact: true })).toHaveText('Восстанавливаем соединение с телевизором');
  await expect(page.locator('.tv-activity').getByRole('button', { name: 'Отменить ожидание', exact: true })).toHaveCount(0);
  await openSettings(page);
  await expect(settings(page).getByRole('button', { name: 'Подключиться снова', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  expect((await tv.status(page)).operation).toBeNull();
  await tv.replaceTv({ kind: 'success' });
  tv.clock.advance(1000);
  await ready(page);
  expect((await state(page, tv)).operation).toMatchObject({ action: 'recover', status: 'succeeded' });
  expect(tv.wakes).toEqual([]);
  expect(tv.promptCount).toBe(1);
});

test('recovery deadline ends retries and status reads never start another cycle', async ({ page, tv }) => {
  await pair(page, tv);
  await tv.makeTvUnavailable();
  await tv.status(page);
  await expect.poll(() => tv.clock.nextDelay).toBe(1000);
  tv.clock.advance(60_000);
  await expect.poll(async () => (await state(page, tv)).operation?.status).toBe('failed');
  expect((await state(page, tv)).operation?.error?.code).toBe('RECOVERY_TIMEOUT');
  await expect.poll(() => tv.clock.pendingCount).toBe(0);
  const attempts = tv.policies.length;
  tv.clock.advance(120_000);
  await tv.status(page);
  await page.reload();
  await expect(page.locator('.power-activity').getByRole('alert')).toContainText('Не удалось подключиться');
  expect(tv.policies).toHaveLength(attempts);
  expect(tv.wakes).toEqual([]);
});

test('lost genuine power response reports uncertainty and never replays shutdown after reconnect or login', async ({ page, tv }) => {
  await tv.replaceTv({ kind: 'close-after-response', uri: off });
  await pair(page, tv);
  const original = tv.tv;
  let posts = 0;
  await page.route(`${tv.origin}/api/tv/power`, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    posts++;
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    await expect.poll(() => original.requests.filter((request) => request.uri === off).length).toBe(1);
    await route.abort('failed');
  });
  await confirmOff(page);
  await expect(page.locator('.power-activity').getByRole('alert')).toContainText('Результат операции неизвестен');
  await page.unroute(`${tv.origin}/api/tv/power`);
  await expect.poll(async () => (await state(page, tv)).operation?.status).toBe('succeeded');
  await tv.replaceTv({ kind: 'success' });
  await openSettings(page);
  await expect(settings(page).getByRole('button', { name: 'Подключиться снова', exact: true })).toBeEnabled();
  await settings(page).getByRole('button', { name: 'Подключиться снова', exact: true }).click();
  await page.keyboard.press('Escape');
  await ready(page);
  await page.reload();
  await ready(page);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await tv.login(page);
  await ready(page);
  expect(posts).toBe(1);
  expect(original.requests.filter((request) => request.uri === off)).toHaveLength(1);
  expect(offRequests(tv)).toEqual([]);
  expect(tv.tv.pointerFrames).toEqual([]);
  expect(tv.promptCount).toBe(1);
});

test('another session cannot cancel wake; initiating logout aborts transport and releases all timers', async ({ page, browser, tv }) => {
  await intentionalOff(page, tv);
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await otherPage.goto(tv.origin);
    await tv.login(otherPage);
    await expect(power(otherPage).getByRole('button', { name: 'Включить ТВ', exact: true })).toBeEnabled();
    tv.holdWake();
    await power(page).getByRole('button', { name: 'Включить ТВ', exact: true }).click();
    await expect.poll(() => tv.wakes.length).toBe(1);
    const id = (await state(page, tv)).operation!.id;
    const denied = await other.request.post(`${tv.origin}/api/tv/power/${id}/cancel`, { headers: await headers(otherPage, tv), data: {} });
    expect(denied.status()).toBe(403);
    await otherPage.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(otherPage.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
    expect(tv.wakes[0]!.signal.aborted).toBe(false);
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
    expect(tv.wakes[0]!.signal.aborted).toBe(true);
    await expect.poll(() => tv.clock.pendingCount).toBe(0);
    expect((await page.context().request.get(`${tv.origin}/api/tv/power`)).status()).toBe(401);
    await tv.login(page);
    await expect(page.getByRole('heading', { name: 'Телевизор', exact: true })).toBeVisible();
    await expect.poll(async () => (await state(page, tv)).operation?.status).toBe('cancelled');
    const attempts = tv.policies.length;
    tv.clock.advance(120_000);
    await tv.status(page);
    expect(tv.policies).toHaveLength(attempts);
    expect(tv.wakes).toHaveLength(1);
    expect(tv.tv.activeSocketCount).toBe(0);
  } finally { await other.close(); }
});
