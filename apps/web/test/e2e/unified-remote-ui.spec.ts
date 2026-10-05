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
  if (mode === 'version-known') status.tv = { host: '192.168.50.20', identity: { model: 'Synthetic TV', platformVersion: '6.5.3', firmwareVersion: '99.8' } };
  if (mode === 'version-missing') status.tv = { host: '192.168.50.20', identity: { model: 'Synthetic TV', firmwareVersion: '99.8' } };
  if (mode === 'long-model') status.tv = { host: '192.168.50.20', identity: { model: 'Synthetic Television Model With A Very Long Identifier' } };
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
      contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/html',
      body: await readFile(new URL(path === '/' ? 'index.html' : path.slice(1), webRoot)),
    });
  });
  await page.goto(origin);
  if (mode !== 'login' && mode !== 'setup') await expect(remote(page).getByRole('button', { name: 'Вверх', exact: true })).toBeEnabled();
  return { reads, mutations, status, power };
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

for (const width of [320, 1280]) {
  test(`settings sections and controls stay consistent at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const { mutations } = await fixture(page);
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    const dialog = settings(page);
    const close = dialog.getByRole('button', { name: 'Закрыть настройки' });
    expect(await close.locator('svg').count()).toBe(1);
    const closeBox = (await close.boundingBox())!;
    const iconBox = (await close.locator('svg').boundingBox())!;
    expect(Math.abs(closeBox.x + closeBox.width / 2 - iconBox.x - iconBox.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(closeBox.y + closeBox.height / 2 - iconBox.y - iconBox.height / 2)).toBeLessThanOrEqual(1);
    await expect(close.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    for (const heading of ['Подключение', 'Включение по сети']) await expect(dialog.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Телевизор', exact: true })).toHaveCount(0);
    const controls = dialog.locator('input, button:not([aria-label])');
    const dimensions = await controls.evaluateAll((elements) => elements.map((element) => ({ height: element.getBoundingClientRect().height, radius: getComputedStyle(element).borderRadius })));
    expect(new Set(dimensions.map(({ height }) => height)).size).toBe(1);
    expect(new Set(dimensions.map(({ radius }) => radius)).size).toBe(1);
    expect(dimensions[0]!.height).toBeGreaterThanOrEqual(44);
    const secondaryBackground = await dialog.getByRole('button', { name: 'Подключиться снова' }).evaluate((element) => getComputedStyle(element).background);
    for (const name of ['Изменить адрес', 'Сохранить MAC']) expect(await dialog.getByRole('button', { name, exact: true }).evaluate((element) => getComputedStyle(element).background)).not.toBe(secondaryBackground);
    const reconnect = (await dialog.getByRole('button', { name: 'Подключиться снова' }).boundingBox())!;
    const repair = (await dialog.getByRole('button', { name: 'Повторить сопряжение' }).boundingBox())!;
    expect(repair.y >= reconnect.y + reconnect.height + 8 || repair.x >= reconnect.x + reconnect.width + 8).toBe(true);
    await noOverflow(page);
    expect(mutations).toEqual([]);
    const screenshot = testInfo.outputPath(`settings-${width}.png`);
    await dialog.screenshot({ path: screenshot });
    await testInfo.attach(`settings-${width}`, { path: screenshot, contentType: 'image/png' });
  });
}

for (const width of [320, 1280]) {
  test(`network wake tooltip follows hover and keyboard focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const { mutations } = await fixture(page, 'version-known');
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    const dialog = settings(page);
    const info = dialog.getByRole('button', { name: 'О включении по сети', exact: true });
    await expect(info).toHaveCount(1);
    const tooltip = dialog.locator('[role="tooltip"]');
    await expect(tooltip).toBeHidden();
    await info.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('Для включения нужен MAC-адрес');
    await expect(tooltip).toContainText('Отправка сигнала не гарантирует включение');
    const bounds = (await tooltip.boundingBox())!;
    const dialogBounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(dialogBounds.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(dialogBounds.x + dialogBounds.width);
    expect(bounds.y).toBeGreaterThanOrEqual(dialogBounds.y);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(dialogBounds.y + dialogBounds.height);
    await dialog.getByRole('heading', { name: 'Настройки телевизора', exact: true }).hover();
    await expect(tooltip).toBeHidden();
    await dialog.getByRole('button', { name: 'Обновить статус', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(info).toBeFocused();
    await expect(tooltip).toBeVisible();
    await dialog.getByRole('button', { name: 'Закрыть настройки' }).focus();
    await expect(tooltip).toBeHidden();
    await dialog.getByRole('button', { name: 'Закрыть настройки' }).click();
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await expect(tooltip).toBeHidden();
    const identity = dialog.locator('.settings-identity');
    await expect(identity).toContainText('Модель: Synthetic TV');
    await expect(identity).toContainText('webOS 6.5.3');
    if (width === 1280) {
      const model = (await identity.locator('.settings-model').boundingBox())!;
      const version = (await identity.locator('.tv-version').boundingBox())!;
      expect(Math.abs(model.y - version.y)).toBeLessThanOrEqual(1);
    }
    expect(mutations).toEqual([]);
    await noOverflow(page);
  });
}

for (const width of [320, 1280]) {
  test(`long model stays beside LG logo without power or navigation overlap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await fixture(page, 'long-model');
    const logo = page.getByRole('img', { name: 'LG', exact: true });
    expect(await logo.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(228);
    const logoBox = (await logo.boundingBox())!;
    const modelBox = (await page.locator('.tv-model').boundingBox())!;
    const powerBox = (await page.getByRole('button', { name: 'Выключить ТВ', exact: true }).boundingBox())!;
    expect(modelBox.x).toBeGreaterThanOrEqual(logoBox.x + logoBox.width);
    expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(powerBox.x);
    expect(modelBox.y + modelBox.height).toBeLessThanOrEqual((await remote(page).boundingBox())!.y);
    await noOverflow(page);
  });
  for (const source of ['connection', 'power'] as const) {
  test(`growing ${source} diagnostic keeps card geometry and viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 400 });
    const { status, power } = await fixture(page);
    const card = page.locator('.tv-card');
    const before = await card.boundingBox();
    expect((await page.locator('.tv-activity').boundingBox())!.y).toBeGreaterThan(400);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    if (source === 'connection') {
      status.connection = 'unavailable';
      status.error = { code: 'TV_UNAVAILABLE', message: longError };
    } else {
      power.operation = { id: '11111111-1111-4111-8111-111111111111', action: 'wake', status: 'failed', phase: 'finished', delivery: 'unknown', startedAt: 0, deadlineAt: 60_000, error: { code: 'SYNTHETIC_ERROR', message: longError } };
    }
    await page.clock.runFor(2000);
    await expect(page.locator('.tv-activity').getByRole('alert')).toHaveText(source === 'power' ? `Результат отправки неизвестен. ${longError}` : longError);
    await expect(page.locator('.tv-activity').getByRole('alert')).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    expect(await card.boundingBox()).toEqual(before);
    await noOverflow(page);
  });
  }
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
    const keypad = remote(page).getByRole('group', { name: 'Цифры', exact: true });
    await expect(keypad).toBeVisible();
    const digitBounds = [];
    for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
      const button = keypad.getByRole('button', { name: digit, exact: true });
      await expect(button).toBeInViewport();
      expect(await button.innerText()).toBe(digit);
      digitBounds.push((await button.boundingBox())!);
    }
    for (let row = 0; row < 3; row++) {
      const [left, middle, right] = digitBounds.slice(row * 3, row * 3 + 3);
      expect(Math.abs(left!.y - middle!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(middle!.y - right!.y)).toBeLessThanOrEqual(1);
      expect(left!.x + left!.width).toBeLessThan(middle!.x);
      expect(middle!.x + middle!.width).toBeLessThan(right!.x);
    }
    expect(Math.abs(digitBounds[9]!.x - digitBounds[1]!.x)).toBeLessThanOrEqual(1);
    expect(digitBounds[9]!.y).toBeGreaterThan(digitBounds[6]!.y);
    expect(digitBounds[9]!.y + digitBounds[9]!.height).toBeLessThan((await up.boundingBox())!.y);
    for (const name of ['Вверх', 'Вниз', 'Влево', 'Вправо', 'OK', 'Домой', 'Назад', 'Громкость −', 'Без звука', 'Громкость +']) {
      const button = remote(page).getByRole('button', { name, exact: true });
      await expect(button).toBeInViewport();
      await expect(button).toHaveAttribute('title', name);
      expect(await button.innerText()).toBe(name === 'OK' ? 'OK' : '');
    }
    const okButton = remote(page).getByRole('button', { name: 'OK', exact: true });
    const upButton = remote(page).getByRole('button', { name: 'Вверх', exact: true });
    const ok = (await okButton.boundingBox())!;
    const upBounds = (await upButton.boundingBox())!;
    expect(Math.abs(ok.width - upBounds.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(ok.height - upBounds.height)).toBeLessThanOrEqual(1);
    for (const property of ['border-radius', 'border-width', 'border-color', 'background-image']) {
      expect(await okButton.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property)).toBe(await upButton.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property));
    }
    for (const button of await page.locator('.tv-card button, .header-actions button').all()) {
      if (await button.locator('svg').count() === 0) continue;
      const control = (await button.boundingBox())!;
      const icon = (await button.locator('svg').boundingBox())!;
      expect(Math.abs(icon.x + icon.width / 2 - control.x - control.width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(icon.y + icon.height / 2 - control.y - control.height / 2)).toBeLessThanOrEqual(1);
    }
    expect(await card.getByRole('status').count()).toBe(0);
    expect(await card.getByRole('alert').count()).toBe(0);
    expect(await card.locator('details').count()).toBe(0);
    await expect(card.locator('.tv-model')).toHaveText('Synthetic TV');
    await expect(card.getByRole('img', { name: 'LG', exact: true })).toBeVisible();
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
      const card = page.locator('.tv-card');
      expect(await card.getByRole('status').count()).toBe(0);
      expect(await card.getByRole('alert').count()).toBe(0);
      const activity = page.locator('.tv-activity');
      await expect(activity.getByRole('status', { name: 'Соединение с телевизором', exact: true })).toBeVisible();
      if (mode.endsWith('error')) await expect(activity.getByRole('alert')).toContainText(longError);
      if (mode.endsWith('running')) await expect(activity.getByText(/Осталось:/)).toBeVisible();
      expect((await activity.boundingBox())!.y).toBeGreaterThanOrEqual((await card.boundingBox())!.y + (await card.boundingBox())!.height);
      await noOverflow(page);
      // Initial diagnostic autofocus can scroll the document. Measure the modal
      // transition from the same viewport, with its opener already on screen.
      await page.evaluate(() => window.scrollTo(0, 0));
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

for (const activation of ['pointer', 'keyboard']) {
  test(`settings dismiss help permanently via ${activation}`, async ({ page }) => {
    const { mutations } = await fixture(page);
    const help = page.locator('.app-header details');
    await help.locator('summary').click();
    await expect(help).toHaveJSProperty('open', true);
    const settings = page.getByRole('button', { name: 'Настройки', exact: true });
    if (activation === 'pointer') await settings.click();
    else { await settings.focus(); await page.keyboard.press('Enter'); }
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(help).toHaveJSProperty('open', false);
    await page.getByRole('button', { name: 'Закрыть настройки' }).click();
    await expect(help).toHaveJSProperty('open', false);
    expect(mutations).toEqual([]);
  });
}
test('settings retain inside clicks but dismiss on free background', async ({ page }) => {
  const { mutations } = await fixture(page);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Настройки телевизора', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 300);
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Настройки', exact: true })).toBeFocused();
  expect(mutations).toEqual([]);
});
test('help retains inside clicks but dismisses on free background', async ({ page }) => {
  const { mutations } = await fixture(page);
  const help = page.locator('.app-header details');
  await help.locator('summary').click();
  await help.locator('p').click();
  await expect(help).toHaveJSProperty('open', true);
  await page.mouse.click(5, 300);
  await expect(help).toHaveJSProperty('open', false);
  expect(mutations).toEqual([]);
});

for (const key of ['Enter', 'Space']) {
  test(`keyboard help toggles with native ${key} without a TV command`, async ({ page }) => {
    const { mutations } = await fixture(page);
    const help = page.locator('.app-header details');
    const summary = help.locator('summary');
    await expect(summary).toHaveAccessibleName('Управление с клавиатуры');
    expect(await summary.innerText()).toBe('');
    await expect(summary.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await summary.focus();
    await expect(summary).toBeFocused();
    await expect(help).toHaveJSProperty('open', false);
    await page.keyboard.press(key);
    await expect(help).toHaveJSProperty('open', true);
    await page.keyboard.press(key);
    await expect(help).toHaveJSProperty('open', false);
    expect(mutations).toEqual([]);
});
}

for (const [mode, text] of [['version-known', 'webOS 6.5.3'], ['version-missing', 'Версия неизвестна']] as const) {
  test(`${mode} keeps model in card and version/session in settings without using firmware`, async ({ page }) => {
    await fixture(page, mode);
    const info = page.locator('.tv-info');
    await expect(info.getByText('Synthetic TV', { exact: true })).toBeVisible();
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    await expect(page.getByText('Вы вошли как synthetic-owner.', { exact: true })).toHaveCount(0);
    await expect(info).not.toContainText('99.8');
    const box = (await info.boundingBox())!;
    expect(box.y).toBeGreaterThan((await page.locator('.tv-card').boundingBox())!.y);
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await expect(settings(page).getByText(text, { exact: true })).toBeVisible();
    await expect(settings(page).getByText('Вы вошли как synthetic-owner.', { exact: true })).toBeVisible();
    await expect(settings(page)).not.toContainText('99.8');
  });
}

test('header keyboard help stays readable inside a 320px viewport without sending commands', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 960 });
  const { mutations } = await fixture(page);
  await page.locator('.app-header summary').click();
  const help = page.locator('#remote-help');
  await expect(help).toBeVisible();
  const box = (await help.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await noOverflow(page);
  expect(mutations).toEqual([]);
});

test('remote command failure remains visible below the controls and never retries', async ({ page }) => {
  const { mutations } = await fixture(page);
  await remote(page).getByRole('button', { name: 'Домой', exact: true }).click();
  await expect(page.locator('.tv-activity').getByRole('alert')).toContainText('Результат команды неизвестен');
  expect(await page.locator('.tv-card').getByRole('alert').count()).toBe(0);
  expect(mutations).toEqual([{ path: '/api/tv/commands', data: { id: expect.any(String), button: 'HOME' } }]);
});

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
  await settings(page).getByRole('heading', { name: 'Настройки телевизора', exact: true }).evaluate((element: HTMLElement) => { element.tabIndex = -1; element.focus(); });
  await page.keyboard.press('Enter');
  await expect(remote(page).getByRole('button', { name: 'Вверх', exact: true })).toBeDisabled();
  const backgroundGear = (await gear.boundingBox())!;
  await page.mouse.click(backgroundGear.x + backgroundGear.width / 2, backgroundGear.y + backgroundGear.height / 2);
  await expect(settings(page)).not.toBeVisible();
  await expect(gear).toBeFocused();
  expect(mutations).toEqual([]);
  await gear.click();
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
