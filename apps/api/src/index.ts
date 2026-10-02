import { loadConfig } from './config.js';
import { createApiRuntime } from './runtime.js';
import { formatStartupError } from './startup-errors.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await createApiRuntime(config);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void app.close().catch(() => {
      console.error('API shutdown failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
}

try {
  await main();
} catch (error) {
  console.error(formatStartupError(error));
  process.exitCode = 1;
}
