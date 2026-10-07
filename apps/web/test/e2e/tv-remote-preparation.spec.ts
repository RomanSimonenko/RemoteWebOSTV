import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { openTvWorkspace } from '../support/dashboard.js';

// Synthetic HTTP responses isolate browser preparation. Full API/SQLite/adapter
// acceptance remains in tv-remote.spec.ts, without these intercepted responses.
const webRoot = new URL('../../dist/', import.meta.url);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function syntheticRemote(page: Page, origin: string) {
  const posts: Array<{ id: string; button: string }> = [];
  await page.route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      '/api/setup/status': { state: 'claimed' },
      '/api/auth/session': { username: 'synthetic', csrfToken: 'c'.repeat(43) },
      '/api/tv': { tv: { host: '192.168.1.20', identity: { model: 'Synthetic TV' } }, connection: 'available', operation: null },
      '/api/tv/remote': { enabled: true, reason: null },
      '/api/tv/power': { mac: null, canPowerOff: true, canWake: false, operation: null },
    };
    if (pathname === '/api/tv/commands') {
      posts.push(route.request().postDataJSON() as { id: string; button: string });
      await route.fulfill({ json: { id: posts.at(-1)!.id, outcome: 'sent' } });
    } else if (pathname in data) await route.fulfill({ json: data[pathname] });
    else await route.fulfill({
      contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html',
      body: await readFile(new URL(pathname === '/' ? 'index.html' : pathname.slice(1), webRoot)),
    });
  });
  await page.goto(origin);
  await openTvWorkspace(page);
  const group = page.getByRole('group', { name: 'Пульт', exact: true });
  await expect(group.getByRole('button', { name: 'Вверх', exact: true })).toBeEnabled();
  return { group, posts };
}

for (const [origin, secureContext] of [['http://localhost', true], ['http://192.0.2.20', false]] as const) {
  test(`synthetic browser preparation sends unique UUIDs with secureContext=${secureContext}`, async ({ page }) => {
    const { group, posts } = await syntheticRemote(page, origin);
    expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, entropy: typeof crypto.getRandomValues })))
      .toEqual({ secure: secureContext, uuid: secureContext ? 'function' : 'undefined', entropy: 'function' });
    for (const label of ['Вверх', 'OK']) {
      await group.getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByRole('status', { name: 'Команды телевизора', exact: true })).toHaveText('Команда отправлена');
    }
    expect(posts).toEqual([{ id: expect.stringMatching(uuid), button: 'UP' }, { id: expect.stringMatching(uuid), button: 'ENTER' }]);
    expect(new Set(posts.map(({ id }) => id)).size).toBe(2);
  });
}

test('synthetic HTTP entropy failure proves zero POST and explicit not-sent feedback', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'getRandomValues', { value: () => { throw new Error('synthetic entropy failure'); } });
  });
  const { group, posts } = await syntheticRemote(page, 'http://192.0.2.20');
  await group.getByRole('button', { name: 'Вверх', exact: true }).click();
  await expect(page.locator('.remote-activity').getByRole('alert')).toContainText('Команда не отправлена');
  await expect(page.locator('.remote-activity').getByRole('alert')).toContainText('идентификатор');
  await expect(group).toHaveAttribute('aria-busy', 'false');
  await expect(group.getByRole('button', { name: 'Вверх', exact: true })).toBeEnabled();
  expect(posts).toEqual([]);
  await expect(group).not.toContainText('Результат команды неизвестен');
  await expect(group).not.toContainText('synthetic entropy failure');
});
