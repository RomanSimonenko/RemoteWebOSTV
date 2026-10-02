import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig(({ command, mode }) => {
  const apiOrigin = process.env.REMOTE_WEBOS_DEV_API_ORIGIN;
  if (command === 'serve' && mode !== 'test' && !apiOrigin) {
    throw new Error('REMOTE_WEBOS_DEV_API_ORIGIN is required for the Vite API proxy');
  }
  return {
    server: {
      strictPort: true,
      ...(apiOrigin ? { proxy: { '/api': { target: apiOrigin, changeOrigin: false } } } : {}),
    },
    test: { environment: 'jsdom', exclude: [...configDefaults.exclude, 'test/e2e/**'] },
  };
});
