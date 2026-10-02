import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  outputDir: '../../.local/playwright',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { browserName: 'chromium', headless: true },
});
