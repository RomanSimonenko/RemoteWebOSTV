import { loadConfig } from './config.js';
import { createApiRuntime } from './runtime.js';

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
  const message = error instanceof Error && error.message.startsWith('REMOTE_WEBOS_')
    ? error.message
    : 'API startup failed';
  console.error(message);
  process.exitCode = 1;
}
