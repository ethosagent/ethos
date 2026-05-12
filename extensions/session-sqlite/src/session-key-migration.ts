import Database from 'better-sqlite3';

// Multi-bot routing session-key migration.
//
// Pre-multi-bot, gateway sessionKeys were `${platform}:${chatId}` (or
// `${platform}:${chatId}:${ts}` after /new). The multi-bot gateway uses
// `${platform}:${botKey}:${chatId}[:${ts}]`. Existing rows persisted in
// `sessions.db` must be rewritten once after upgrade.
//
// This module owns the SQLite-side work. Schema-level UPDATEs and raw
// `node:fs` / `better-sqlite3` access are permitted here (the scanner
// allowlist covers `extensions/session-sqlite/`). Callers in apps/
// handle marker-file bookkeeping via the Storage contract and orchestrate
// when to run.

export interface SessionKeyMigrationResult {
  migrated: number;
  alreadyMigrated: number;
  skippedNoBot: number;
}

export interface MigrateSessionKeysOptions {
  /** Absolute path to the SQLite sessions database. */
  dbPath: string;
  /** Per-platform set of botKeys present in the resolved gateway config.
   *  Rows whose 2nd key segment matches one of these are treated as
   *  already migrated. */
  knownByPlatform: ReadonlyMap<string, ReadonlySet<string>>;
  /** Per-platform primary botKey — the value used to prefix legacy
   *  2-part keys for that platform. Typically the first configured bot
   *  for that platform (post-shim, that's the legacy bot). */
  primaryByPlatform: ReadonlyMap<string, string>;
}

type Decision =
  | { kind: 'rewrite'; newKey: string }
  | { kind: 'skip-already-migrated' }
  | { kind: 'skip-no-bot' };

/**
 * Decide what to do with a single session key. Pure function — exported
 * for unit tests; the migration runner threads each row's decision
 * through a transaction with collision preflight.
 *
 * Heuristic:
 *   - 1-part keys (no `:`) are platform-less and skipped.
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
  const rest = parts.slice(1).join(':');
  return { kind: 'rewrite', newKey: `${platform}:${primary}:${rest}` };
}

/**
 * Rewrite legacy session keys to the multi-bot lane format. Synchronous
 * because better-sqlite3 is synchronous; safe to call once at boot
 * before the SessionStore opens its own connection.
 *
 * Collision preflight: builds the full rewrite plan in memory before
 * any UPDATE runs. If two rows would land on the same key, or a row's
 * target key already exists, throws with details instead of half-
 * migrating and dying on the UNIQUE constraint.
 */
export function migrateSessionKeys(opts: MigrateSessionKeysOptions): SessionKeyMigrationResult {
  const db = new Database(opts.dbPath);
  let migrated = 0;
  let alreadyMigrated = 0;
  let skippedNoBot = 0;
  try {
    const rows = db.prepare('SELECT id, key FROM sessions').all() as Array<{
      id: string;
      key: string;
    }>;
    const existingKeys = new Set(rows.map((r) => r.key));
    const targets = new Map<string, string>(); // newKey → rowId
    const collisions: string[] = [];
    type Plan = { id: string; newKey: string };
    const plan: Plan[] = [];
    for (const row of rows) {
      const decision = decideMigration(row.key, opts.knownByPlatform, opts.primaryByPlatform);
      if (decision.kind === 'skip-already-migrated') {
        alreadyMigrated++;
        continue;
      }
      if (decision.kind === 'skip-no-bot') {
        skippedNoBot++;
        continue;
      }
      const { newKey } = decision;
      if (existingKeys.has(newKey) && newKey !== row.key) {
        collisions.push(
          `${row.key} → ${newKey} (target already exists). Inspect ${opts.dbPath} manually.`,
        );
        continue;
      }
      const dupe = targets.get(newKey);
      if (dupe) {
        collisions.push(`${row.key} and (id=${dupe}) both decide to ${newKey}.`);
        continue;
      }
      targets.set(newKey, row.id);
      plan.push({ id: row.id, newKey });
    }
    if (collisions.length > 0) {
      throw new Error(
        `Session-key migration aborted: ${collisions.length} collision(s) detected.\n` +
          `${collisions.join('\n')}\n` +
          `Back up sessions.db and resolve manually before retrying.`,
      );
    }
    const update = db.prepare('UPDATE sessions SET key = ? WHERE id = ?');
    const tx = db.transaction((items: Plan[]) => {
      for (const item of items) {
        update.run(item.newKey, item.id);
        migrated++;
      }
    });
    tx(plan);
  } finally {
    db.close();
  }
  return { migrated, alreadyMigrated, skippedNoBot };
}
