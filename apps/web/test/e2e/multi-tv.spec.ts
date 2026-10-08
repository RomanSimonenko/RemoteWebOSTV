import { expect, type Page } from '@playwright/test';
import { test, tvHost, secondHost, samsungHost, failedHost, type TvFixture } from '../support/tv-fixture.js';

async function add(page: Page, host: string, platform = 'webos') {
  await page.getByRole('button', { name: 'Добавить ТВ', exact: true }).click();
  await page.getByLabel('Платформа телевизора').selectOption(platform);
  await page.getByLabel('IP-адрес телевизора').fill(host);
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/tvs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  const response = await accepted; expect(response.status()).toBe(202);
  return (await response.json() as { tvId: string }).tvId;
}
async function pairMixed(page: Page, tv: TvFixture) {
  await tv.setupAndLogin(page);
  const first = await add(page, tvHost);
  await tv.tv.waitForRequestCount(1); tv.promptGate.release();
  await expect(page.locator('.device-card')).toHaveCount(1);
  const second = await add(page, samsungHost, 'tizen');
  await expect(page.locator('.device-card')).toHaveCount(2);
  return { first, second };
}
async function logout(page: Page) {
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByRole('dialog', { name: 'Выйти из приложения?' }).getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
}
async function pairBoth(page: Page, tv: TvFixture) {
  await tv.setupAndLogin(page); await tv.enableSecondTv();
  const first = await add(page, tvHost);
  await tv.tv.waitForRequestCount(1); tv.promptGate.release();
  await expect(page.locator('.device-card')).toHaveCount(1);
  const second = await add(page, secondHost);
  await expect(page.locator('.device-card')).toHaveCount(2);
  return { first, second };
}
async function open(page: Page, index: number) {
  await page.getByRole('button', { name: /^Открыть телевизор / }).nth(index).click();
  await expect(page.getByRole('button', { name: 'Вверх', exact: true })).toBeEnabled();
}
test('two tabs control different TVs and keyboard/hold stay with the selected TV', async ({ page, context, tv }) => {
  await pairBoth(page, tv);
  const other = await context.newPage();
  try {
    await other.goto(tv.origin); await open(page, 0); await open(other, 1);
    await page.getByRole('button', { name: 'Вверх', exact: true }).click(); await tv.tv.waitForPointerFrameCount(1);
    await other.getByRole('group', { name: 'Пульт', exact: true }).focus(); await other.keyboard.press('ArrowDown'); await tv.secondTv.waitForPointerFrameCount(1);
    expect(tv.tv.pointerFrames).toEqual(['type:button\nname:UP\n\n']);
    expect(tv.secondTv.pointerFrames).toEqual(['type:button\nname:DOWN\n\n']);
    await page.clock.install();
    const up = page.getByRole('button', { name: 'Вверх', exact: true }); await up.hover(); await page.mouse.down(); await tv.tv.waitForPointerFrameCount(2);
    await page.getByRole('button', { name: 'Телевизоры', exact: true }).click(); await page.mouse.up();
    await page.clock.runFor(2000);
    expect(tv.tv.pointerFrames).toHaveLength(2); expect(tv.secondTv.pointerFrames).toHaveLength(1);
    await open(page, 1); await page.getByRole('button', { name: 'OK', exact: true }).click(); await tv.secondTv.waitForPointerFrameCount(2);
    expect(tv.secondTv.pointerFrames.at(-1)).toBe('type:button\nname:ENTER\n\n');
    expect(tv.tv.pointerFrames).toHaveLength(2);
  } finally { await other.close(); }
});
test('failed addition preserves the first saved card', async ({ page, tv }) => {
  await tv.setupAndLogin(page);
  const first = await add(page, tvHost); await tv.tv.waitForRequestCount(1); tv.promptGate.release();
  await expect(page.locator('.device-card')).toHaveCount(1);
  await add(page, failedHost);
  await expect(page.getByRole('alert')).toContainText('Телевизор недоступен');
  await page.getByRole('button', { name: 'Телевизоры', exact: true }).click();
  await expect(page.locator('.device-card')).toHaveCount(1);
  const list = await page.request.get(`${tv.origin}/api/tvs`);
  expect((await list.json()).devices.map((device: { tvId: string }) => device.tvId)).toEqual([first]);
});
test('API restart preserves both device IDs and independent control', async ({ page, tv }) => {
  const ids = await pairBoth(page, tv);
  await tv.restart(); await page.reload();
  await expect(page.locator('.device-card')).toHaveCount(2);
  const list = await page.request.get(`${tv.origin}/api/tvs`);
  expect((await list.json()).devices.map((device: { tvId: string }) => device.tvId)).toEqual([ids.first, ids.second]);
  await open(page, 1); await page.getByRole('button', { name: 'Назад', exact: true }).click(); await tv.secondTv.waitForPointerFrameCount(1);
  expect(tv.tv.pointerFrames).toHaveLength(0);
  expect(tv.secondTv.pointerFrames).toEqual(['type:button\nname:BACK\n\n']);
});
test('LG and Samsung tabs route keyboard and hold independently and switching stops repetition', async ({ page, context, tv }) => {
  await pairMixed(page, tv);
  const other = await context.newPage();
  try {
    await other.goto(tv.origin); await open(page, 0); await open(other, 1);
    await page.getByRole('button', { name: 'Вверх', exact: true }).click(); await tv.tv.waitForPointerFrameCount(1);
    await other.getByRole('group', { name: 'Пульт', exact: true }).focus(); await other.keyboard.press('ArrowDown');
    await expect.poll(() => tv.samsungSockets[0]!.frames).toEqual(['{"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"KEY_DOWN","Option":"false","TypeOfRemote":"SendRemoteKey"}}']);
    expect(tv.tv.pointerFrames).toEqual(['type:button\nname:UP\n\n']);
    expect(tv.samsungSockets[0]!.readyState).toBe(1);
    await page.clock.install();
    await page.getByRole('button', { name: 'Вверх', exact: true }).hover(); await page.mouse.down(); await tv.tv.waitForPointerFrameCount(2);
    await page.clock.runFor(400); await tv.tv.waitForPointerFrameCount(3);
    await page.getByRole('button', { name: 'Телевизоры', exact: true }).click(); await page.mouse.up(); await open(page, 1);
    await page.clock.runFor(1000);
    expect(tv.tv.pointerFrames).toHaveLength(3); expect(tv.samsungSockets[0]!.frames).toHaveLength(1);
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    await expect.poll(() => tv.samsungSockets[0]!.frames.at(-1)).toBe('{"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"KEY_ENTER","Option":"false","TypeOfRemote":"SendRemoteKey"}}');
    expect(tv.tv.activeSocketCount).toBeGreaterThan(0);
  } finally { await other.close(); }
});
test('mixed restart preserves IDs and credentials without another LG or Samsung prompt', async ({ page, tv }) => {
  const ids = await pairMixed(page, tv);
  const prompts = tv.promptCount;
  // Deferred-pairing deliberately emits PROMPT even with a saved key. The
  // ordinary success scenario models a TV accepting its saved registration.
  await tv.replaceTv({ kind: 'success' });
  await tv.restart(); await page.reload();
  await expect(page.locator('.device-card')).toHaveCount(2);
  const list = await page.request.get(`${tv.origin}/api/tvs`);
  expect((await list.json()).devices.map((device: { tvId: string; platform: string }) => [device.tvId, device.platform])).toEqual([[ids.first, 'webos'], [ids.second, 'tizen']]);
  await open(page, 1); await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect.poll(() => tv.samsungSockets.at(-1)!.frames).toEqual(['{"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"KEY_RETURN","Option":"false","TypeOfRemote":"SendRemoteKey"}}']);
  await page.getByRole('button', { name: 'Телевизоры', exact: true }).click(); await open(page, 0);
  await page.getByRole('button', { name: 'OK', exact: true }).click(); await tv.tv.waitForPointerFrameCount(1);
  expect(tv.promptCount).toBe(prompts);
  expect(tv.samsungConnections).toEqual([{ prompted: true }, { prompted: false }]);
});
test('Samsung uses shared desktop geometry, unsupported controls and camera cleanup', async ({ page, tv }, testInfo) => {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const stream = canvas.captureStream();
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => stream });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [] });
    (window as unknown as { syntheticCamera: MediaStream }).syntheticCamera = stream;
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await pairMixed(page, tv);
  const badges = page.locator('.platform-badge');
  const lgBadge = (await badges.nth(0).boundingBox())!;
  const samsungBadge = (await badges.nth(1).boundingBox())!;
  expect(lgBadge.height).toBe(38);
  expect(samsungBadge.height).toBe(lgBadge.height);
  const cards = await page.locator('.device-card').evaluateAll((elements) => elements.map(element => {
    const { width, height } = element.getBoundingClientRect(); return { width, height };
  }));
  await badges.evaluateAll((elements) => elements.forEach(element => { (element as HTMLElement).style.minHeight = '0'; }));
  expect((await badges.nth(0).boundingBox())!.width).toBe(lgBadge.width);
  expect((await badges.nth(1).boundingBox())!.width).toBe(samsungBadge.width);
  expect(await page.locator('.device-card').evaluateAll((elements) => elements.map(element => {
    const { width, height } = element.getBoundingClientRect(); return { width, height };
  }))).toEqual(cards);
  await badges.evaluateAll((elements) => elements.forEach(element => { (element as HTMLElement).style.removeProperty('min-height'); }));
  await page.screenshot({ path: testInfo.outputPath('mixed-dashboard.png'), fullPage: true });
  await open(page, 0);
  const lgGeometry = await page.locator('.tv-card').boundingBox();
  await page.getByRole('button', { name: 'Телевизоры', exact: true }).click(); await open(page, 1);
  const samsungGeometry = await page.locator('.tv-card').boundingBox();
  expect(samsungGeometry).toEqual(lgGeometry);
  expect((await page.locator('.webcam-actions').boundingBox())!.height).toBe(44);
  await expect(page.getByRole('button', { name: 'Питание ТВ', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Запустить Wink', exact: true })).toBeDisabled();
  await expect(page.getByRole('img', { name: 'LG', exact: true })).toHaveCount(0);
  await expect(page.locator('.tv-info')).toContainText('Samsung');
  const posts: string[] = []; page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Tizen');
  await expect(page.getByRole('dialog')).not.toContainText('2.0.25');
  await expect(page.getByRole('dialog')).toContainText('Включение по сети для этого телевизора пока недоступно в приложении.');
  await expect(page.getByRole('button', { name: 'Сохранить MAC', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('samsung-shared-settings.png'), fullPage: true });
  await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Включить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Выключить', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('samsung-shared-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Телевизоры', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { syntheticCamera: MediaStream }).syntheticCamera.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  expect(posts).toEqual([]);
});
test('only final session logout closes both TVs and next login reconnects saved credentials manually', async ({ page, browser, tv }) => {
  await pairMixed(page, tv); await open(page, 0);
  const independent = await browser.newContext();
  const other = await independent.newPage();
  try {
    await other.goto(tv.origin); await tv.login(other); await open(other, 1);
    await logout(page);
    expect(tv.tv.activeSocketCount).toBeGreaterThan(0); expect(tv.samsungSockets[0]!.readyState).toBe(1);
    await other.getByRole('button', { name: 'OK', exact: true }).click();
    await expect.poll(() => tv.samsungSockets[0]!.frames.length).toBe(1);
    await logout(other);
    await tv.tv.waitForActiveSocketCount(0);
    expect(tv.samsungSockets[0]!.readyState).toBe(3); expect(tv.samsungSockets[0]!.listenerCount).toBe(0);
    await tv.login(page); await expect(page.locator('.device-card')).toHaveCount(2);
    expect(tv.samsungSockets).toHaveLength(1); expect(tv.tv.activeSocketCount).toBe(0);
    await page.getByRole('button', { name: /^Открыть телевизор / }).nth(1).click();
    await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('button', { name: 'Подключиться снова', exact: true }).click();
    await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
    await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeEnabled();
    expect(tv.samsungConnections).toEqual([{ prompted: true }, { prompted: false }]);
    expect(tv.tv.activeSocketCount).toBe(0);
  } finally { await independent.close(); }
});
