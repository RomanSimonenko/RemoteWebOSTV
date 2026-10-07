import { expect, type Page } from '@playwright/test';

/** Explicitly enter the current TV workspace after login or reload. */
export async function openTvWorkspace(page: Page) {
  await expect(page.getByRole('heading', { name: 'Телевизоры', exact: true })).toBeVisible();
  await expect(page.getByText('Загрузка телевизоров…', { exact: true })).toHaveCount(0);
  const card = page.getByRole('button', { name: /^Открыть телевизор / });
  if (await card.count()) await card.first().click();
  else await page.getByRole('button', { name: 'Добавить ТВ', exact: true }).click();
}
