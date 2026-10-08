import { WebOsError } from '@remote-webos-tv/tv-adapter';
import type { ClientKeyStore } from '@remote-webos-tv/webos';

export function createStagingKeyStore(initialKey?: string): ClientKeyStore {
  let key = initialKey;
  return {
    async load() { return key; },
    async save(value) {
      if (!value) throw new WebOsError('KEY_STORE_WRITE_FAILED', 'Refusing to stage an empty key');
      key = value;
    },
    async clear() { key = undefined; },
  };
}
