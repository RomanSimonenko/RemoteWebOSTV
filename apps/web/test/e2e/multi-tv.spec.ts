import { expect, type Page } from '@playwright/test';
import { test, tvHost, secondHost, failedHost, type TvFixture } from '../support/tv-fixture.js';

async function add(page: Page, host: string) {
  await page.getByRole('button', { name: 'Добавить ТВ', exact: true }).click();
  await page.getByLabel('IP-адрес телевизора').fill(host);
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/tvs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  const response = await accepted; expect(response.status()).toBe(202);
  return (await response.json() as { tvId: string }).tvId;
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
