import { savedTvViewSchema, tvMacAddressSchema, tvIdSchema, localTvHostSchema, type SavedTvView, type TvId } from '@remote-webos-tv/contracts';
import { randomUUID } from 'node:crypto';
import { encryptedEnvelopeV1Schema, type EncryptedEnvelopeV1 } from '@remote-webos-tv/webos';
import type Database from 'better-sqlite3';

export type StoredTv = SavedTvView & {
  readonly encryptedClientKey: EncryptedEnvelopeV1;
  readonly macAddress: string | null;
};
export interface TvRepository {
  load(): StoredTv | null;
  replace(value: StoredTv): void;
  hasStoredKey(): boolean;
}

function validatedTv(host: unknown, identity: unknown, envelope: unknown, macAddress: unknown): StoredTv {
  const view = savedTvViewSchema.parse({ host, identity });
  if (view.host !== host) throw new Error('Stored TV host must be canonical');
  return { ...view, encryptedClientKey: encryptedEnvelopeV1Schema.parse(envelope), macAddress: tvMacAddressSchema.nullable().parse(macAddress) };
}

export interface TvDeviceRepository {
  remove(tvId: TvId): void;
  list(): Array<{ tvId: TvId; platform: 'webos' }>;
  forDevice(tvId: TvId): TvRepository;
  legacyId(): TvId | null;
  hostOwner(host: string): TvId | null;
}

export function createTvDeviceRepository(sqlite: Database.Database): TvDeviceRepository {
  const remove = sqlite.transaction((tvId: TvId) => {
    sqlite.prepare('DELETE FROM tv_default WHERE tv_id = ?').run(tvId);
    sqlite.prepare('DELETE FROM tv_devices WHERE tv_id = ?').run(tvId);
    sqlite.prepare('INSERT INTO tv_default (id, tv_id) SELECT 1, tv_id FROM tv_devices ORDER BY position LIMIT 1 ON CONFLICT(id) DO NOTHING').run();
  });
  return {
    remove(tvId) { remove.immediate(tvIdSchema.parse(tvId)); },
    list() {
      return (sqlite.prepare('SELECT tv_id, platform FROM tv_devices ORDER BY position').all() as { tv_id: string; platform: string }[]).map((row) => {
        if (row.platform !== 'webos') throw new Error('Unsupported stored TV platform');
        return { tvId: tvIdSchema.parse(row.tv_id), platform: 'webos' as const };
      });
    },
    forDevice(tvId) { return createTvRepository(sqlite, tvIdSchema.parse(tvId)); },
    legacyId() { const row = sqlite.prepare('SELECT tv_id FROM tv_default WHERE id = 1').get() as { tv_id: string } | undefined; return row ? tvIdSchema.parse(row.tv_id) : null; },
    hostOwner(host) { const row = sqlite.prepare('SELECT tv_id FROM tv_devices WHERE host = ?').get(localTvHostSchema.parse(host)) as { tv_id: string } | undefined; return row ? tvIdSchema.parse(row.tv_id) : null; },
  };
}

export function createTvRepository(sqlite: Database.Database, tvId?: TvId): TvRepository {
  const devices = createTvDeviceRepository(sqlite);
  const ownId = tvId ?? devices.legacyId() ?? randomUUID();
  const select = sqlite.prepare('SELECT host, identity_json, encrypted_client_key_json, mac_address FROM tv_devices WHERE tv_id = ?');
  const exists = sqlite.prepare('SELECT 1 FROM tv_devices WHERE tv_id = ?');
  const replace = sqlite.transaction((value: StoredTv) => {
    sqlite.prepare(`INSERT INTO tv_devices (tv_id, platform, host, identity_json, encrypted_client_key_json, mac_address)
      VALUES (?, 'webos', ?, ?, ?, ?) ON CONFLICT(tv_id) DO UPDATE SET host = excluded.host,
      identity_json = excluded.identity_json, encrypted_client_key_json = excluded.encrypted_client_key_json,
      mac_address = excluded.mac_address`)
      .run(ownId, value.host, JSON.stringify(value.identity), JSON.stringify(value.encryptedClientKey), value.macAddress);
    sqlite.prepare('INSERT INTO tv_default (id, tv_id) VALUES (1, ?) ON CONFLICT(id) DO NOTHING').run(ownId);
  });
  return {
    load() {
      const row = select.get(ownId) as { host: unknown; identity_json: string; encrypted_client_key_json: string; mac_address: unknown } | undefined;
      if (!row) return null;
      return validatedTv(row.host, JSON.parse(row.identity_json), JSON.parse(row.encrypted_client_key_json), row.mac_address);
    },
    replace(value) { replace.immediate(validatedTv(value.host, value.identity, value.encryptedClientKey, value.macAddress)); },
    hasStoredKey() { return exists.get(ownId) !== undefined; },
  };
}
