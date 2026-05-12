import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger, Storage } from '@ethosagent/types';
import Database from 'better-sqlite3';
import { deriveBotKey, type EthosConfig, ethosDir } from '../config';

// Phase 1 — multi-bot routing session-key migration.
//
// Pre-multi-bot, gateway sessionKeys were `${platform}:${chatId}` (or
// `${platform}:${chatId}:${ts}` after /new). The multi-bot gateway uses
// `${platform}:${botKey}:${chatId}[:${ts}]`. Existing sessions persisted
// in `~/.ethos/sessions.db` must be rewritten once after upgrade so the
// conversation history stays attached to the right lane.
//
// The migration is idempotent two ways:
//   - A marker file at `<dataDir>/.session-key-migration-v1.done` records
//     that the migration has run; subsequent boots short-circuit.
//   - Even without the marker, we only rewrite rows whose `key` second
//     segment doesn't look like a known botKey for the platform.

const MARKER_BASENAME = '.session-key-migration-v1.done';

export interface SessionKeyMigrationResult {
  /** Number of session rows rewritten. */
  migrated: number;
  /** Number of rows already in the new shape (skipped). */
  alreadyMigrated: number;
  /** Number of rows skipped because the platform has no configured bot. */
  skippedNoBot: number;
}

/**
 * Run the session-key migration. Safe to call on every gateway boot —
 * idempotent via the marker file and per-row inspection. Returns a
 * summary suitable for logging.
 */
export async function migrateSessionKeysIfNeeded(opts: {
  storage: Storage;
  config: EthosConfig;
  logger?: Logger;
}): Promise<SessionKeyMigrationResult | null> {
  const dir = ethosDir();
  const marker = join(dir, MARKER_BASENAME);
  if (await opts.storage.exists(marker)) return null;

  const dbPath = join(dir, 'sessions.db');
  if (!existsSync(dbPath)) {
    // First-ever boot: there's nothing to migrate. Drop the marker so
    // we don't keep checking.
    await opts.storage.write(marker, new Date().toISOString());
    return { migrated: 0, alreadyMigrated: 0, skippedNoBot: 0 };
  }

  // Build the platform → known botKeys lookup from the resolved config.
  // Sessions whose 2nd segment matches a known botKey are treated as
  // already migrated. The "primary" botKey (first configured for the
  // platform) is what we prefix legacy keys with.
  const knownByPlatform = new Map<string, Set<string>>();
  const primaryByPlatform = new Map<string, string>();
  for (const bot of opts.config.telegram?.bots ?? []) {
    const k = deriveBotKey(bot);
    knownByPlatform.set('telegram', (knownByPlatform.get('telegram') ?? new Set()).add(k));
    if (!primaryByPlatform.has('telegram')) primaryByPlatform.set('telegram', k);
  }
  for (const app of opts.config.slack?.apps ?? []) {
    const k = deriveBotKey(app);
    knownByPlatform.set('slack', (knownByPlatform.get('slack') ?? new Set()).add(k));
    if (!primaryByPlatform.has('slack')) primaryByPlatform.set('slack', k);
  }

  // Open the SQLite directly. Migration is a one-shot operation outside
  // the SessionStore contract; doing it through Storage would lose the
  // transactional UPDATE semantics we need.
  const db = new Database(dbPath);
  let migrated = 0;
  let alreadyMigrated = 0;
  let skippedNoBot = 0;
  try {
    const rows = db.prepare('SELECT id, key FROM sessions').all() as Array<{
      id: string;
      key: string;
    }>;
    const update = db.prepare('UPDATE sessions SET key = ? WHERE id = ?');
    const tx = db.transaction((items: Array<{ id: string; key: string }>) => {
      for (const row of items) {
        const decision = decideMigration(row.key, knownByPlatform, primaryByPlatform);
        if (decision.kind === 'skip-already-migrated') {
          alreadyMigrated++;
          continue;
        }
        if (decision.kind === 'skip-no-bot') {
          skippedNoBot++;
          continue;
        }
        update.run(decision.newKey, row.id);
        migrated++;
      }
    });
    tx(rows);
  } finally {
    db.close();
  }

  await opts.storage.write(marker, new Date().toISOString());
  opts.logger?.info(
    `[session-keys] migration done: ${migrated} migrated, ${alreadyMigrated} already, ${skippedNoBot} skipped`,
    { component: 'gateway', migrated, alreadyMigrated, skippedNoBot },
  );
  return { migrated, alreadyMigrated, skippedNoBot };
}

type Decision =
  | { kind: 'rewrite'; newKey: string }
  | { kind: 'skip-already-migrated' }
  | { kind: 'skip-no-bot' };

/**
 * Decide what to do with a single session key. Exported for unit
 * tests; the caller threads decisions through a transaction.
 *
 * Heuristic:
 *   - 1-part keys (no `:`) are platform-less and left alone.
 *   - 2+ part keys: platform = first segment.
 *     - No configured bot for this platform → skip (operator removed it).
 *     - Second segment matches a known botKey → already migrated.
 *     - Otherwise → prepend the platform's primary botKey, keeping the
 *       rest of the original key (including any /new timestamp suffix).
 */
export function decideMigration(
  key: string,
  knownByPlatform: ReadonlyMap<string, ReadonlySet<string>>,
  primaryByPlatform: ReadonlyMap<string, string>,
): Decision {
  const parts = key.split(':');
  if (parts.length < 2) return { kind: 'skip-no-bot' };
  const platform = parts[0];
  const second = parts[1];
  const primary = primaryByPlatform.get(platform);
  if (!primary) return { kind: 'skip-no-bot' };
  const known = knownByPlatform.get(platform);
  if (known?.has(second)) return { kind: 'skip-already-migrated' };
  // Prepend the primary botKey, preserving the rest of the original
  // shape (`${chatId}` or `${chatId}:${ts}`).
  const rest = parts.slice(1).join(':');
  return { kind: 'rewrite', newKey: `${platform}:${primary}:${rest}` };
}
