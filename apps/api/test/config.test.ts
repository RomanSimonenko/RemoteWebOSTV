import { describe, expect, test } from 'vitest';

import { loadConfig } from '../src/config.js';

const validEnv = {
  REMOTE_WEBOS_DATA_DIR: '/synthetic/data',
  REMOTE_WEBOS_HOST: '127.0.0.1',
  REMOTE_WEBOS_PORT: '8080',
  REMOTE_WEBOS_PUBLIC_ORIGIN: 'https://remote.example.test',
};

describe('API configuration', () => {
  test.each(['0', '999', '300001', '1.5', '-1', 'abc', '', '1000ms'])('rejects invalid recovery budget %j', (value) => {
    expect(() => loadConfig({ ...validEnv, REMOTE_WEBOS_RECOVERY_TIMEOUT_MS: value })).toThrow(/REMOTE_WEBOS_RECOVERY_TIMEOUT_MS/);
  });
  test.each([['1000', 1000], ['300000', 300000], [undefined, 60000]] as const)('loads recovery budget %j', (value, expected) => {
    expect(loadConfig({ ...validEnv, REMOTE_WEBOS_RECOVERY_TIMEOUT_MS: value }).recoveryTimeoutMs).toBe(expected);
  });
  test('loads explicit binding and security configuration', () => {
    expect(loadConfig(validEnv)).toEqual({
      dataDir: '/synthetic/data',
      host: '127.0.0.1',
      port: 8080,
      publicOrigin: 'https://remote.example.test',
      secureCookies: true,
      trustedProxy: [],
      recoveryTimeoutMs: 60_000,
    });
  });

  test.each([undefined, '', 'https://remote.example.test/path', 'https://remote.example.test?x=1', 'https://user:pass@remote.example.test', 'not-a-url'])('rejects missing or non-origin public URL %j', (origin) => {
    expect(() => loadConfig({ ...validEnv, REMOTE_WEBOS_PUBLIC_ORIGIN: origin })).toThrow(/REMOTE_WEBOS_PUBLIC_ORIGIN/);
  });

  test.each([undefined, '0', '-1', '65536', '8080.5', 'abc'])('rejects missing or invalid port %j', (port) => {
    expect(() => loadConfig({ ...validEnv, REMOTE_WEBOS_PORT: port })).toThrow(/REMOTE_WEBOS_PORT/);
  });

  test('rejects missing data directory and host', () => {
    expect(() => loadConfig({ ...validEnv, REMOTE_WEBOS_DATA_DIR: undefined })).toThrow(/REMOTE_WEBOS_DATA_DIR/);
    expect(() => loadConfig({ ...validEnv, REMOTE_WEBOS_HOST: undefined })).toThrow(/REMOTE_WEBOS_HOST/);
  });

  test('requires explicit valid booleans and trusted proxy addresses', () => {
    expect(loadConfig({ ...validEnv, REMOTE_WEBOS_SECURE_COOKIES: 'false', REMOTE_WEBOS_TRUSTED_PROXY: '192.0.2.1' }).secureCookies).toBe(false);
    expect(loadConfig({ ...validEnv, REMOTE_WEBOS_TRUSTED_PROXY: '192.0.2.1' }).trustedProxy).toEqual(['192.0.2.1']);
    expect(() => loadConfig({ ...validEnv, REMOTE_WEBOS_SECURE_COOKIES: 'maybe' })).toThrow(/REMOTE_WEBOS_SECURE_COOKIES/);
    expect(() => loadConfig({ ...validEnv, REMOTE_WEBOS_TRUSTED_PROXY: '*' })).toThrow(/REMOTE_WEBOS_TRUSTED_PROXY/);
  });
});
