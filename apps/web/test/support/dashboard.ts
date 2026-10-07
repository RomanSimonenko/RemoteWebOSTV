import { expect, type Page } from '@playwright/test';

/** Explicitly enter the current TV workspace after login or reload. */
export async function openTvWorkspace(page: Page) {
  await expect(page.getByRole('heading', { name: 'Телевизоры', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^(Добавить ТВ|Открыть телевизор .*)$/ }).click();
}
