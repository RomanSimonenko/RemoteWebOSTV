import { savedTvViewSchema, type SavedTvView } from '@remote-webos-tv/contracts';
import { encryptedEnvelopeV1Schema, type EncryptedEnvelopeV1 } from '@remote-webos-tv/webos';
import type Database from 'better-sqlite3';

export type StoredTv = SavedTvView & { readonly encryptedClientKey: EncryptedEnvelopeV1 };
export interface TvRepository {
  load(): StoredTv | null;
  replace(value: StoredTv): void;
  hasStoredKey(): boolean;
}

function validatedTv(host: unknown, identity: unknown, envelope: unknown): StoredTv {
  const view = savedTvViewSchema.parse({ host, identity });
  if (view.host !== host) throw new Error('Stored TV host must be canonical');
  return { ...view, encryptedClientKey: encryptedEnvelopeV1Schema.parse(envelope) };
}

export function createTvRepository(sqlite: Database.Database): TvRepository {
  const select = sqlite.prepare('SELECT host, identity_json, encrypted_client_key_json FROM tv_config WHERE id = 1');
  const exists = sqlite.prepare('SELECT 1 FROM tv_config LIMIT 1');
  const replace = sqlite.transaction((value: StoredTv) => {
    sqlite.prepare(`INSERT INTO tv_config (id, host, identity_json, encrypted_client_key_json)
      VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET host = excluded.host,
      identity_json = excluded.identity_json, encrypted_client_key_json = excluded.encrypted_client_key_json`)
      .run(value.host, JSON.stringify(value.identity), JSON.stringify(value.encryptedClientKey));
  });
  return {
    load() {
      const row = select.get() as { host: unknown; identity_json: string; encrypted_client_key_json: string } | undefined;
      if (!row) return null;
      return validatedTv(row.host, JSON.parse(row.identity_json), JSON.parse(row.encrypted_client_key_json));
    },
    replace(value) { replace.immediate(validatedTv(value.host, value.identity, value.encryptedClientKey)); },
    hasStoredKey() { return exists.get() !== undefined; },
  };
}
