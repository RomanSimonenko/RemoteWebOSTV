import { expect, type Page, type Response } from '@playwright/test';
import { openTvWorkspace } from "../support/dashboard.js";
import { test, gate, tvHost, type TvFixture } from '../support/tv-fixture.js';

const mappings = [
  ['Вверх', 'UP'], ['Вниз', 'DOWN'], ['Влево', 'LEFT'], ['Вправо', 'RIGHT'],
  ['OK', 'ENTER'], ['Назад', 'BACK'], ['Домой', 'HOME'],
  ['Громкость +', 'VOLUMEUP'], ['Громкость −', 'VOLUMEDOWN'], ['Без звука', 'MUTE'],
] as const;
const frame = (name: string) => `type:button\nname:${name}\n\n`;
const remote = (page: Page) => page.getByRole('group', { name: 'Пульт', exact: true });
const commandResponse = (page: Page, tv: TvFixture) => page.waitForResponse((response) =>
  response.url() === `${tv.origin}${tv.tvPath}/commands` && response.request().method() === 'POST');

async function ready(page: Page) {
  await expect(page.getByRole('status', { name: 'Соединение с телевизором' })).toHaveText('Подключён');
  await expect(remote(page).getByRole('button', { name: 'Вверх', exact: true })).toBeEnabled();
}

async function pair(page: Page, tv: TvFixture) {
  await tv.setupAndLogin(page);
  await openTvWorkspace(page);
  await page.getByLabel('IP-адрес телевизора').fill(tvHost);
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await tv.tv.waitForRequestCount(1);
  tv.promptGate.release();
  await openTvWorkspace(page);
  await ready(page);
}

async function sent(response: Response) {
  expect(response.status()).toBe(200);
  const request = response.request().postDataJSON() as { id: string; button: string };
  expect(request.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(await response.json()).toEqual({ id: request.id, outcome: 'sent' });
}

async function press(page: Page, tv: TvFixture, key: string) {
  const response = commandResponse(page, tv);
  await page.keyboard.press(key);
  await sent(await response);
  await expect(page.getByRole('status', { name: 'Команды телевизора', exact: true })).toHaveText('Команда отправлена');
}

test('all ten browser controls reach the pointer once; saved TV remains usable after reload and login', async ({ page, tv }) => {
  await pair(page, tv);
  const original = tv.tv;
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url() === `${tv.origin}${tv.tvPath}/commands` && request.method() === 'POST') requests.push(request.postData()!);
  });
  for (const [label, name] of mappings) {
    const response = commandResponse(page, tv);
    await remote(page).getByRole('button', { name: label, exact: true }).click();
    await sent(await response);
    await expect(page.getByRole('status', { name: 'Команды телевизора', exact: true })).toHaveText('Команда отправлена');
    await tv.tv.waitForPointerFrameCount(requests.length);
    expect(tv.tv.pointerFrames.at(-1)).toBe(frame(name));
  }
  expect(tv.tv.pointerFrames).toEqual(mappings.map(([, name]) => frame(name)));
  expect(requests).toHaveLength(10);
  expect(new Set(requests.map((raw) => (JSON.parse(raw) as { id: string }).id)).size).toBe(10);
  await page.reload();
  await openTvWorkspace(page);
  await ready(page);
  // Reopen the real SQLite-backed API as well; no new prompt is permitted.
  await tv.replaceTv({ kind: 'success' });
  await tv.restart();
  await page.reload();
  await openTvWorkspace(page);
  await ready(page);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByRole('dialog', { name: 'Выйти из приложения?' }).getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
  expect((await page.context().request.get(`${tv.origin}${tv.tvPath}/remote`)).status()).toBe(401);
  expect((await page.context().request.post(`${tv.origin}${tv.tvPath}/commands`, {
    headers: { origin: tv.origin }, data: { id: '11111111-1111-4111-8111-111111111111', button: 'UP' },
  })).status()).toBe(401);
  await tv.login(page);
  await openTvWorkspace(page);
  await ready(page);
  await remote(page).focus();
  await press(page, tv, 'Home');
  await tv.tv.waitForPointerFrameCount(1);
  const session = await page.context().request.get(`${tv.origin}/api/auth/session`);
  const { csrfToken } = await session.json() as { csrfToken: string };
  for (const headers of [{ origin: tv.origin }, { origin: 'https://foreign.example.test', 'x-csrf-token': csrfToken }]) {
    expect((await page.context().request.post(`${tv.origin}${tv.tvPath}/commands`, {
      headers, data: { id: '22222222-2222-4222-8222-222222222222', button: 'UP' },
    })).status()).toBe(403);
  }
  expect(original.pointerFrames).toEqual(mappings.map(([, name]) => frame(name)));
  expect(tv.tv.pointerFrames).toEqual([frame('HOME')]);
  expect(tv.promptCount).toBe(1);
  expect(await tv.hasExposedSecrets(await page.locator('body').innerText())).toBe(false);
  expect(await tv.logsHaveSecrets()).toBe(false);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test('channel and color buttons send exact pointer frames once without replay', async ({ page, tv }) => {
  await pair(page, tv);
  const entries = [['Канал −', 'CHANNEL_DOWN', 'CHANNELDOWN'], ['Канал +', 'CHANNEL_UP', 'CHANNELUP'], ['Красная', 'RED', 'RED'], ['Зелёная', 'GREEN', 'GREEN'], ['Жёлтая', 'YELLOW', 'YELLOW'], ['Синяя', 'BLUE', 'BLUE']];
  for (const [label, button, wire] of entries) {
    const response = commandResponse(page, tv);
    await remote(page).getByRole('button', { name: label!, exact: true }).click();
    const result = await response; await sent(result);
    expect(result.request().postDataJSON().button).toBe(button);
    await tv.tv.waitForPointerFrameCount(entries.findIndex((entry) => entry[0] === label) + 1);
    expect(tv.tv.pointerFrames.at(-1)).toBe(frame(wire!));
  }
  expect(tv.tv.pointerFrames).toEqual(entries.map((entry) => frame(entry[2]!)));
  await page.reload();
  await openTvWorkspace(page); await ready(page);
  expect(tv.tv.pointerFrames).toEqual(entries.map((entry) => frame(entry[2]!)));
});

test('numeric keypad sends each digit once through authenticated API and pointer without replay', async ({ page, tv }) => {
  await pair(page, tv);
  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  const ids = new Set<string>();
  for (const digit of digits) {
    const response = commandResponse(page, tv);
    await remote(page).getByRole('button', { name: digit, exact: true }).click();
    const result = await response;
    await sent(result);
    const request = result.request().postDataJSON() as { id: string; button: string };
    expect(request.button).toBe(digit);
    expect(ids.has(request.id)).toBe(false);
    ids.add(request.id);
    await expect(page.getByRole('status', { name: 'Команды телевизора', exact: true })).toHaveText('Команда отправлена');
    await tv.tv.waitForPointerFrameCount(ids.size);
    expect(tv.tv.pointerFrames.at(-1)).toBe(frame(digit));
  }
  expect(tv.tv.pointerFrames).toEqual(digits.map(frame));
  await page.reload();
  await openTvWorkspace(page);
  await ready(page);
  expect(tv.tv.pointerFrames).toEqual(digits.map(frame));
});

test('native keyboard maps ten controls with one Enter owner and ignores modifiers and outside focus', async ({ page, tv }) => {
  await pair(page, tv);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url() === `${tv.origin}${tv.tvPath}/commands` && request.method() === 'POST') requests.push(request.postData()!);
  });
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByLabel('IP-адрес телевизора').focus();
  await page.keyboard.press('ArrowUp');
  await page.getByRole('button', { name: 'Обновить статус', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await remote(page).focus();
  for (const key of ['Control+ArrowUp', 'Alt+ArrowDown', 'Meta+ArrowLeft']) await page.keyboard.press(key);
  await remote(page).getByRole('button', { name: 'Домой', exact: true }).focus();
  for (const key of ['Control+Enter', 'Alt+Enter', 'Meta+Enter']) await page.keyboard.press(key);
  await press(page, tv, 'Enter');
  await remote(page).focus();
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Home', 'Shift+Equal', '-', 'm']) await press(page, tv, key);
  await tv.tv.waitForPointerFrameCount(10);
  expect(tv.tv.pointerFrames).toEqual(['ENTER', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'BACK', 'HOME', 'VOLUMEUP', 'VOLUMEDOWN', 'MUTE'].map(frame));
  expect(requests).toHaveLength(10);
});

for (const mode of ['mouse', 'keyboard', 'space'] as const) {
  test(`native ${mode} hold repeats at controlled times and stops without a release duplicate`, async ({ page, tv }) => {
    await pair(page, tv);
    const button = remote(page).getByRole('button', { name: 'Громкость +', exact: true });
    await button.scrollIntoViewIfNeeded();
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 100));
    const first = commandResponse(page, tv);
    if (mode === 'mouse') { const box = (await button.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); }
    else if (mode === 'space') { await button.focus(); await page.keyboard.down('Space'); }
    else { await remote(page).focus(); await page.keyboard.down('+'); }
    await sent(await first);
    const second = commandResponse(page, tv); await page.clock.runFor(400); await sent(await second);
    const third = commandResponse(page, tv); await page.clock.runFor(200); await sent(await third);
    if (mode === 'mouse') await page.mouse.up(); else await page.keyboard.up(mode === 'space' ? 'Space' : '+');
    await page.clock.runFor(1000);
    expect(tv.tv.pointerFrames).toEqual([frame('VOLUMEUP'), frame('VOLUMEUP'), frame('VOLUMEUP')]);
  });
}

test('native held keys do not repeat or queue while a genuine response is pending', async ({ page, tv }) => {
  await pair(page, tv);
  await remote(page).focus();
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url() === `${tv.origin}${tv.tvPath}/commands` && request.method() === 'POST') requests.push(request.postData()!);
  });
  const accepted = gate();
  const deliver = gate();
  await page.route(`${tv.origin}${tv.tvPath}/commands`, async (route) => {
    const response = await route.fetch();
    accepted.release();
    await deliver.promise;
    await route.fulfill({ response });
  });
  try {
    const response = commandResponse(page, tv);
    await page.keyboard.down('ArrowUp');
    await accepted.promise;
    await expect(remote(page)).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.down('ArrowUp'); // Chromium emits repeat=true while held.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('ArrowUp');
    deliver.release();
    await sent(await response);
    await page.unroute(`${tv.origin}${tv.tvPath}/commands`);
    await expect(remote(page)).toHaveAttribute('aria-busy', 'false');
    // Repeat again after pending clears: suppression must not rely on busy admission.
    const left = commandResponse(page, tv);
    await page.keyboard.down('ArrowLeft');
    await sent(await left);
    await expect(remote(page)).toHaveAttribute('aria-busy', 'false');
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.up('ArrowLeft');
    await press(page, tv, 'Home');
    await tv.tv.waitForPointerFrameCount(3);
    expect(tv.tv.pointerFrames).toEqual(['UP', 'LEFT', 'HOME'].map(frame));
    expect(requests).toHaveLength(3);
  } finally { deliver.release(); await page.keyboard.up('ArrowUp'); await page.keyboard.up('ArrowLeft'); }
});

test('offline remote disables commands and reconnect never replays offline input', async ({ page, tv }) => {
  await pair(page, tv);
  const original = tv.tv;
  await tv.makeTvUnavailable();
  await tv.expireUnavailableRecovery(page);
  await expect(page.getByRole('status', { name: 'Соединение с телевизором' })).toHaveText('Нет соединения');
  await expect(page.locator('.connection-led')).toHaveAttribute('data-color', 'gray');
  await expect(page.locator('.tv-activity')).toHaveText('');
  for (const [label] of mappings) await expect(remote(page).getByRole('button', { name: label, exact: true })).toBeDisabled();
  await remote(page).focus();
  await page.keyboard.press('ArrowUp');
  const session = await page.context().request.get(`${tv.origin}/api/auth/session`);
  const { csrfToken } = await session.json() as { csrfToken: string };
  const rejected = await page.context().request.post(`${tv.origin}${tv.tvPath}/commands`, {
    headers: { origin: tv.origin, 'x-csrf-token': csrfToken },
    data: { id: '33333333-3333-4333-8333-333333333333', button: 'UP' },
  });
  expect(rejected.status()).toBe(409);
  expect(await rejected.json()).toMatchObject({ id: '33333333-3333-4333-8333-333333333333', outcome: 'rejected', error: { code: 'TV_UNAVAILABLE' } });
  await tv.replaceTv({ kind: 'success' });
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Подключиться снова', exact: true }).click();
  await page.keyboard.press('Escape');
  await ready(page);
  await remote(page).focus();
  await press(page, tv, 'Home');
  await tv.tv.waitForPointerFrameCount(1);
  expect(original.pointerFrames).toEqual([]);
  expect(tv.tv.pointerFrames).toEqual([frame('HOME')]);
  expect(tv.promptCount).toBe(1);
});

test('lost genuine command response after pointer receipt shows uncertainty and reconnect does not replay it', async ({ page, tv }) => {
  await pair(page, tv);
  const received = gate();
  const loseResponse = gate();
  const original = tv.tv;
  await page.route(`${tv.origin}${tv.tvPath}/commands`, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await original.waitForPointerFrameCount(1);
    received.release();
    await loseResponse.promise;
    await route.abort('failed');
  });
  try {
    await remote(page).getByRole('button', { name: 'Вверх', exact: true }).click();
    await received.promise;
    expect(original.pointerFrames).toEqual([frame('UP')]);
    await tv.makeTvUnavailable();
    loseResponse.release();
    await expect(page.locator('.remote-activity').getByRole('alert')).toHaveText('Результат команды неизвестен. Автоматический повтор не выполняется');
    await page.unroute(`${tv.origin}${tv.tvPath}/commands`);
    await tv.expireUnavailableRecovery(page);
    await expect(page.getByRole('status', { name: 'Соединение с телевизором' })).toHaveText('Нет соединения');
    await tv.replaceTv({ kind: 'success' });
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('button', { name: 'Подключиться снова', exact: true }).click();
    await page.keyboard.press('Escape');
    await ready(page);
    await expect(page.locator('.remote-activity').getByRole('alert')).toHaveText('Результат команды неизвестен. Автоматический повтор не выполняется');
    await remote(page).focus();
    await press(page, tv, 'Home');
    await tv.tv.waitForPointerFrameCount(1);
    expect(tv.tv.pointerFrames).toEqual([frame('HOME')]);
    expect(original.pointerFrames).toEqual([frame('UP')]);
    expect(tv.promptCount).toBe(1);
  } finally { loseResponse.release(); }
});

test('branded Wink launches installed app once through SSAP and reports missing installation', async ({ page, tv }, testInfo) => {
  await pair(page, tv);
  await tv.replaceTv({ kind: 'success', apps: [{ id: 'synthetic.wink', title: 'Wink' }, { id: 'synthetic.wink.dev', title: 'Wink Dev' }] });
  await tv.restart(); await page.reload();
  await openTvWorkspace(page); await ready(page);
  const wink = remote(page).getByRole('button', { name: 'Запустить Wink', exact: true });
  await expect(wink).toBeVisible();
  await expect(wink.locator('img')).toHaveJSProperty('complete', true);
  expect(await wink.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const response = commandResponse(page, tv); await wink.focus(); await page.keyboard.press('Enter'); await sent(await response);
  expect(tv.tv.requests.filter((request) => request.uri === 'ssap://com.webos.applicationManager/launch').map((request) => request.payload)).toEqual([{ id: 'synthetic.wink' }]);
  expect(tv.tv.pointerFrames).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('wink-preview.png'), fullPage: true });
  await tv.replaceTv({ kind: 'success' }); await tv.restart(); await page.reload();
  await openTvWorkspace(page); await ready(page);
  const missingResponse = commandResponse(page, tv); await wink.click();
  expect((await missingResponse).status()).toBe(422);
  await expect(page.locator('.remote-activity').getByRole('alert')).toContainText('Wink не найден');
  expect(tv.tv.requests.filter((request) => request.uri === 'ssap://com.webos.applicationManager/launch')).toEqual([]);
});
