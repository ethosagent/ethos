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
    return { migrated: 0, alreadyMigrated: 0, skippedNoBot: 0 };
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
  await opts.storage.write(marker, new Date().toISOString());
  opts.logger?.info(
    `[session-keys] migration done: ${result.migrated} migrated, ${result.alreadyMigrated} already, ${result.skippedNoBot} skipped`,
    {
      component: 'gateway',
      migrated: result.migrated,
      alreadyMigrated: result.alreadyMigrated,
      skippedNoBot: result.skippedNoBot,
    },
  );
  return result;
}
