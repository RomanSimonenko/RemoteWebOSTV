import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

export interface AppConfig {
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
  readonly trustedProxy: readonly string[];
}

export class AppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppConfigError';
  }
}

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new AppConfigError(`${name} is required`);
  return value;
}

function parseTrustedProxy(value: string | undefined): string[] {
  if (value === undefined || value === '') return [];
  const entries = value.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address ?? '');
    const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (extra !== undefined || maxPrefix === 0 || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > maxPrefix))) {
      throw new AppConfigError('REMOTE_WEBOS_TRUSTED_PROXY must contain IP addresses or CIDR ranges');
    }
  }
  return entries;
}

export function loadConfig(env: Environment): AppConfig {
  const dataDir = required(env, 'REMOTE_WEBOS_DATA_DIR');
  if (!isAbsolute(dataDir)) throw new AppConfigError('REMOTE_WEBOS_DATA_DIR must be an absolute path');

  const host = required(env, 'REMOTE_WEBOS_HOST');
  if (/\s/.test(host)) throw new AppConfigError('REMOTE_WEBOS_HOST must not contain whitespace');

  const portValue = required(env, 'REMOTE_WEBOS_PORT');
  if (!/^\d+$/.test(portValue) || Number(portValue) < 1 || Number(portValue) > 65535) {
    throw new AppConfigError('REMOTE_WEBOS_PORT must be an integer from 1 to 65535');
  }

  const publicOrigin = required(env, 'REMOTE_WEBOS_PUBLIC_ORIGIN');
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(publicOrigin);
  } catch {
    throw new AppConfigError('REMOTE_WEBOS_PUBLIC_ORIGIN must be an exact HTTP(S) origin');
  }
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== publicOrigin || parsedOrigin.username || parsedOrigin.password) {
    throw new AppConfigError('REMOTE_WEBOS_PUBLIC_ORIGIN must be an exact HTTP(S) origin');
  }

  const secureCookiesValue = env.REMOTE_WEBOS_SECURE_COOKIES;
  if (secureCookiesValue !== undefined && secureCookiesValue !== 'true' && secureCookiesValue !== 'false') {
    throw new AppConfigError('REMOTE_WEBOS_SECURE_COOKIES must be true or false');
  }

  return {
    dataDir,
    host,
    port: Number(portValue),
    publicOrigin,
    secureCookies: secureCookiesValue === undefined ? parsedOrigin.protocol === 'https:' : secureCookiesValue === 'true',
    trustedProxy: parseTrustedProxy(env.REMOTE_WEBOS_TRUSTED_PROXY),
  };
}
