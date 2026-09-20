import Database from '@ethosagent/sqlite';

// SqlitePushDeviceStore — the phones that registered for push (mobile-app plan
// S5). One row per `(api_key_id, expo_push_token)`: the same key on a second
// handset is a second row, never an eviction of the first. Lives in sessions.db
// beside `api_keys` (`api-key-store.ts`) because every read joins it: a key's
// revocation is a soft delete (`revoked_at`), so `listForActiveKeys` filters on
// `revoked_at IS NULL` and a revoked key stops receiving push on the next event
// with no cascade. `sweepRevoked` removes those dead rows.
//
// Construct AFTER `SqliteApiKeyStore` on the same file — the joins need the
// `api_keys` table that store creates.

export type PushPlatform = 'ios' | 'android';

export interface PushDeviceCategories {
  approvals: boolean;
  clarify: boolean;
  cronFailures: boolean;
  teamAttention: boolean;
  runFinished: boolean;
}

export interface RegisterPushDeviceInput {
  apiKeyId: string;
  expoPushToken: string;
  platform: PushPlatform;
  categories: PushDeviceCategories;
  liveActivities: boolean;
  appVersion: string;
}

export interface PushDeviceRecord extends RegisterPushDeviceInput {
  lastRegisteredAt: string;
}

export interface PushDeviceWithKey extends PushDeviceRecord {
  keyName: string;
  keyPrefix: string;
}

interface PushDeviceRow {
  api_key_id: string;
  expo_push_token: string;
  platform: string;
  categories: string;
  live_activities: number;
  app_version: string;
  last_registered_at: string;
  key_name?: string;
  key_prefix?: string;
}

const ACTIVE_JOIN = `FROM push_devices d JOIN api_keys k ON k.id = d.api_key_id
  WHERE k.revoked_at IS NULL`;

export class SqlitePushDeviceStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_devices (
        api_key_id         TEXT NOT NULL,
        expo_push_token    TEXT NOT NULL,
        platform           TEXT NOT NULL,
        categories         TEXT NOT NULL,
        live_activities    INTEGER NOT NULL,
        app_version        TEXT NOT NULL,
        last_registered_at TEXT NOT NULL,
        PRIMARY KEY (api_key_id, expo_push_token)
      ) STRICT;
    `);
  }

  /** Upsert — re-registering the same token under the same key refreshes it. */
  register(input: RegisterPushDeviceInput): void {
    this.db
      .prepare(
        `INSERT INTO push_devices (api_key_id, expo_push_token, platform, categories, live_activities, app_version, last_registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (api_key_id, expo_push_token) DO UPDATE SET
           platform = excluded.platform, categories = excluded.categories,
           live_activities = excluded.live_activities, app_version = excluded.app_version,
           last_registered_at = excluded.last_registered_at`,
      )
      .run(
        input.apiKeyId,
        input.expoPushToken,
        input.platform,
        JSON.stringify(input.categories),
        input.liveActivities ? 1 : 0,
        input.appVersion,
        new Date().toISOString(),
      );
  }

  /** Remove one key's row for a token. Without `apiKeyId`, every key's row for it. */
  unregister(expoPushToken: string, apiKeyId?: string): boolean {
    const result =
      apiKeyId === undefined
        ? this.db.prepare('DELETE FROM push_devices WHERE expo_push_token = ?').run(expoPushToken)
        : this.db
            .prepare('DELETE FROM push_devices WHERE expo_push_token = ? AND api_key_id = ?')
            .run(expoPushToken, apiKeyId);
    return result.changes > 0;
  }

  /** Devices whose key is not revoked — the dispatcher's fan-out set. */
  listForActiveKeys(apiKeyId?: string): PushDeviceRecord[] {
    const rows = (
      apiKeyId === undefined
        ? this.db.prepare(`SELECT d.* ${ACTIVE_JOIN}`).all()
        : this.db.prepare(`SELECT d.* ${ACTIVE_JOIN} AND d.api_key_id = ?`).all(apiKeyId)
    ) as PushDeviceRow[];
    return rows.map(rowToRecord);
  }

  /** Same set, with the owning key's name and prefix — `push.listDevices`. */
  listWithKeys(): PushDeviceWithKey[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, k.name AS key_name, k.prefix AS key_prefix ${ACTIVE_JOIN}
         ORDER BY d.last_registered_at DESC`,
      )
      .all() as PushDeviceRow[];
    return rows.map((r) => ({
      ...rowToRecord(r),
      keyName: r.key_name ?? '',
      keyPrefix: r.key_prefix ?? '',
    }));
  }

  /** Expo said `DeviceNotRegistered` — the token is dead for every key. */
  removeToken(expoPushToken: string): void {
    this.unregister(expoPushToken);
  }

  /** Retention sweep: drop rows whose key is revoked or gone. Returns the count. */
  sweepRevoked(): number {
    return this.db
      .prepare(
        `DELETE FROM push_devices WHERE api_key_id NOT IN
           (SELECT id FROM api_keys WHERE revoked_at IS NULL)`,
      )
      .run().changes;
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(r: PushDeviceRow): PushDeviceRecord {
  return {
    apiKeyId: r.api_key_id,
    expoPushToken: r.expo_push_token,
    platform: r.platform === 'android' ? 'android' : 'ios',
    categories: JSON.parse(r.categories) as PushDeviceCategories,
    liveActivities: r.live_activities === 1,
    appVersion: r.app_version,
    lastRegisteredAt: r.last_registered_at,
  };
}
