import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { TvStatusResponse, TvPowerState } from '../../../../packages/contracts/src/index.js';

const origin = 'http://remote.example.test';
const webRoot = new URL('../../dist/', import.meta.url);
const longError = 'Синтетическая ошибка соединения: ' + 'недоступный-телевизор-'.repeat(30);
const remote = (page: Page) => page.getByRole('group', { name: 'Пульт', exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Настройки телевизора', exact: true });

// Only HTTP is replaced: built React, native dialog, focus and layout run in Chromium.
// Full API/SQLite/adapter contracts remain covered by the existing TV fixture specs.
async function fixture(page: Page, mode = 'idle') {
  await page.clock.install({ time: new Date('2026-10-04T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-04T12:00:01Z'));
  const now = Date.parse('2026-10-04T12:00:00Z');
  const status: { -readonly [Key in keyof TvStatusResponse]: TvStatusResponse[Key] } = { tv: { host: '192.168.50.20', identity: { model: 'Synthetic TV' } }, connection: 'available', operation: null };
  const power: { -readonly [Key in keyof TvPowerState]: TvPowerState[Key] } = { mac: '02:00:00:00:00:03', canPowerOff: true, canWake: false, operation: null };
  if (mode === 'connection-running') {
    status.connection = 'connecting';
    status.operation = { id: 'synthetic-operation', action: 'reconnect', status: 'running', startedAt: now, deadlineAt: now + 60_000 };
  }
  if (mode === 'connection-error') status.error = { code: 'TV_UNAVAILABLE', message: longError };
  if (mode === 'power-running' || mode === 'power-error') {
    power.canPowerOff = false;
    power.operation = { id: '11111111-1111-4111-8111-111111111111', action: 'wake', status: mode === 'power-running' ? 'running' : 'failed', phase: mode === 'power-running' ? 'connecting' : 'finished', delivery: 'unknown', startedAt: now, deadlineAt: now + 60_000,
      ...(mode === 'power-error' ? { error: { code: 'SYNTHETIC_ERROR', message: longError } } : {}) };
  }
  const reads: string[] = [];
  const mutations: Array<{ path: string; data: unknown }> = [];
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) {
      if (route.request().method() !== 'GET') {
        mutations.push({ path, data: route.request().postDataJSON() });
        await route.fulfill({ status: 503, json: { code: 'SYNTHETIC_FAILURE', message: 'Синтетический отказ' } });
        return;
      }
      reads.push(path);
      const data: Record<string, unknown> = {
        '/api/setup/status': { state: mode === 'setup' ? 'unclaimed' : 'claimed' },
        '/api/auth/session': { username: 'synthetic-owner', csrfToken: 'c'.repeat(43) },
        '/api/tv': status,
        '/api/tv/remote': { enabled: true, reason: null },
        '/api/tv/power': power,
      };
      await route.fulfill({ status: mode === 'login' && path === '/api/auth/session' ? 401 : 200, json: data[path] });
    } else await route.fulfill({
      contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',
      body: await readFile(new URL(path === '/' ? 'index.html' : path.slice(1), webRoot)),
    });
  });
  await page.goto(origin);
  if (mode !== 'login' && mode !== 'setup') await expect(remote(page).getByRole('button', { name: 'Вверх', exact: true })).toBeEnabled();
  return { reads, mutations };
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

for (const width of [320, 1280]) {
  test(`compact semantic controls fit ${width}px with power above D-pad`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await fixture(page);
    await noOverflow(page);
    const card = page.locator('.tv-card');
    const box = (await card.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(400);
    const up = remote(page).getByRole('button', { name: 'Вверх', exact: true });
    const power = page.getByRole('button', { name: 'Выключить ТВ', exact: true });
    expect((await power.boundingBox())!.y).toBeLessThan((await up.boundingBox())!.y);
    await expect(remote(page).getByRole('group', { name: 'Навигация', exact: true })).toBeVisible();
    await expect(remote(page).getByRole('group', { name: 'Домой и назад', exact: true })).toBeVisible();
    await expect(remote(page).getByRole('group', { name: 'Громкость', exact: true })).toBeVisible();
    for (const name of ['Вверх', 'Вниз', 'Влево', 'Вправо', 'OK', 'Домой', 'Назад', 'Громкость −', 'Без звука', 'Громкость +']) {
      await expect(remote(page).getByRole('button', { name, exact: true })).toBeInViewport();
    }
    await expect(card).not.toContainText('192.168.50.20', { useInnerText: true });
    await expect(card).not.toContainText('02:00:00:00:00:03', { useInnerText: true });
    expect(await card.getByRole('button', { name: 'Настройки', exact: true }).count()).toBe(0);
    const screenshot = testInfo.outputPath(`compact-${width}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(`compact-${width}`, { path: screenshot, contentType: 'image/png' });
  });

  for (const mode of ['idle', 'connection-running', 'connection-error', 'power-running', 'power-error']) {
    test(`${mode} card and controls stay fixed through settings at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 960 });
      const { reads, mutations } = await fixture(page, mode);
      if (mode.endsWith('error')) await expect(page.getByRole('alert')).toContainText(longError);
      await noOverflow(page);
      // Initial diagnostic autofocus can scroll the document. Measure the modal
      // transition from the same viewport, with its opener already on screen.
      await page.evaluate(() => window.scrollTo(0, 0));
      const card = page.locator('.tv-card');
      const before = [await card.boundingBox(), await remote(page).boundingBox()];
      const initialReads = [...reads];
      await page.getByRole('button', { name: 'Настройки', exact: true }).click();
      await expect(settings(page)).toBeVisible();
      expect([await card.boundingBox(), await remote(page).boundingBox()]).toEqual(before);
      await noOverflow(page);
      if (mode.endsWith('error')) {
        const alert = settings(page).getByRole('alert');
        await expect(alert).toContainText(longError);
        expect(await alert.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(settings(page)).not.toBeVisible();
      expect([await card.boundingBox(), await remote(page).boundingBox()]).toEqual(before);
      expect(mutations).toEqual([]);
      expect(reads).toEqual(initialReads);
    });
  }

  for (const mode of ['login', 'setup']) {
    test(`${mode} uses readable forms without overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 960 });
      await fixture(page, mode);
      await expect(page.getByRole('heading', { name: mode === 'login' ? 'Вход' : 'Первичная настройка', exact: true })).toBeVisible();
      await expect(page.getByLabel('Имя владельца')).toBeInViewport();
      await noOverflow(page);
    });
  }
}

test('native settings trap focus, block pointer and TV keys, then restore gear focus', async ({ page }) => {
  const { mutations } = await fixture(page);
  const gear = page.getByRole('button', { name: 'Настройки', exact: true });
  await gear.click();
  await expect(settings(page).getByRole('button', { name: 'Закрыть настройки' })).toBeFocused();
  for (let index = 0; index < 18; index++) {
    await page.keyboard.press(index % 2 ? 'Tab' : 'Shift+Tab');
    expect(await settings(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await settings(page).getByLabel('IP-адрес телевизора').focus();
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) await page.keyboard.press(key);
  await settings(page).getByRole('heading').evaluate((element: HTMLElement) => { element.tabIndex = -1; element.focus(); });
  await page.keyboard.press('Enter');
  await expect(remote(page).getByRole('button', { name: 'Вверх', exact: true })).toBeDisabled();
  const backgroundGear = (await gear.boundingBox())!;
  await page.mouse.click(backgroundGear.x + backgroundGear.width / 2, backgroundGear.y + backgroundGear.height / 2);
  await expect(settings(page)).toBeVisible();
  expect(mutations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(gear).toBeFocused();
  expect(mutations).toEqual([]);
});

test('power confirmation excludes settings and sends only the explicitly confirmed power POST', async ({ page }) => {
  const { mutations } = await fixture(page);
  const gear = page.getByRole('button', { name: 'Настройки', exact: true });
  await page.getByRole('button', { name: 'Выключить ТВ', exact: true }).click();
  await expect(gear).toBeDisabled();
  await page.getByRole('button', { name: 'Не выключать', exact: true }).click();
  expect(mutations).toEqual([]);
  await expect(gear).toBeEnabled();
  await gear.click();
  await expect(page.getByRole('button', { name: 'Выключить ТВ', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Выключить ТВ', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить выключение', exact: true }).click();
  await expect.poll(() => mutations).toEqual([{ path: '/api/tv/power', data: { id: expect.any(String), action: 'power_off', confirm: true } }]);
});
