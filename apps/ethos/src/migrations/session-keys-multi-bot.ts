import { join } from 'node:path';
import { migrateSessionKeys, type SessionKeyMigrationResult } from '@ethosagent/session-sqlite';
import type { Logger, Storage } from '@ethosagent/types';
import { deriveBotKey, type EthosConfig, ethosDir } from '../config';

// Multi-bot routing session-key migration — orchestrator.
//
// The SQLite-side rewrite lives in `@ethosagent/session-sqlite` (the
// package that owns the schema and is constitutionally permitted to
// open raw DB connections). This file owns the boot-time orchestration:
// when to run, the marker-file bookkeeping via Storage, and translating
// the multi-bot config into the platform/botKey maps the rewriter needs.
//
// Idempotent two ways:
//   - A marker file at `<dataDir>/.session-key-migration-v1.done`
//     records that the migration has run; subsequent boots short-circuit.
//   - Even without the marker, the rewriter recognizes already-migrated
//     keys via the configured-botKey set.

const MARKER_BASENAME = '.session-key-migration-v1.done';

export async function migrateSessionKeysIfNeeded(opts: {
  storage: Storage;
  config: EthosConfig;
  logger?: Logger;
}): Promise<SessionKeyMigrationResult | null> {
  const dir = ethosDir();
  const marker = join(dir, MARKER_BASENAME);
  if (await opts.storage.exists(marker)) return null;

  const dbPath = join(dir, 'sessions.db');
  if (!(await opts.storage.exists(dbPath))) {
    // First-ever boot: nothing to migrate. Drop the marker so subsequent
    // boots don't keep re-checking.
    await opts.storage.write(marker, new Date().toISOString());
    return { migrated: 0, alreadyMigrated: 0, skippedNoBot: 0, quarantinedStale: 0 };
  }

  // Build the platform → known/primary botKey lookups from the resolved
  // config. "Primary" is the first configured bot for each platform —
  // post-shim, that's the legacy bot that wrote the existing session keys.
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

  const result = migrateSessionKeys({ dbPath, knownByPlatform, primaryByPlatform });
  // Only write the marker when every legacy row had a configured bot
  // to migrate to. If the operator's current config doesn't cover a
  // platform that has historical rows (e.g. they upgrade with Slack
  // history but only Telegram bots configured), we leave those rows
  // alone AND skip writing the marker so a later boot — once Slack
  // is configured — will re-run and migrate them.
  //
  // Idempotency stays cheap: rows for already-handled platforms are
  // recognized by `decideMigration` as `skip-already-migrated` (their
  // 2nd segment matches a known botKey), so the re-runs only touch
  // genuinely-stale rows. The cost is one SELECT per boot until every
  // historical platform has been covered.
  if (result.skippedNoBot === 0) {
    await opts.storage.write(marker, new Date().toISOString());
  }
  opts.logger?.info(
    `[session-keys] migration done: ${result.migrated} migrated, ${result.alreadyMigrated} already, ` +
      `${result.quarantinedStale} quarantined (stale), ${result.skippedNoBot} skipped (no bot)` +
      (result.skippedNoBot > 0
        ? ' — marker not written; will re-run if more bots are configured'
        : ''),
    {
      component: 'gateway',
      migrated: result.migrated,
      alreadyMigrated: result.alreadyMigrated,
      skippedNoBot: result.skippedNoBot,
      quarantinedStale: result.quarantinedStale,
    },
  );
  return result;
}
