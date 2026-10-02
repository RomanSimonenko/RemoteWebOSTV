import { loadConfig } from './config.js';
import { fileURLToPath } from 'node:url';
import { createApiRuntime, serveApi } from './runtime.js';
import { formatStartupError } from './startup-errors.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const webRoot = fileURLToPath(new URL('../../../web/dist/', import.meta.url));
  const app = await createApiRuntime(config, { webRoot });

  await serveApi(app, config);
}

try {
  await main();
} catch (error) {
  console.error(formatStartupError(error));
  process.exitCode = 1;
}
