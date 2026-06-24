import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import Database from '@ethosagent/sqlite';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EthosConfig } from '../config';
import { migrateSessionKeysIfNeeded } from '../migrations/session-keys-multi-bot';

// Phase 1 follow-up — the orchestrator wraps the SQLite-side rewrite
// with marker-file bookkeeping. Two behaviors covered here:
//   1. Marker is NOT written when any rows were skipped because no bot
//      was configured for their platform — so a later boot that adds
//      more bots re-runs migration on those legacy rows.
//   2. Marker IS written once every legacy row has either been
//      migrated or quarantined (no `skip-no-bot` outcomes remaining).
//
// Storage-backed for end-to-end realism — sessions.db is a real
// SQLite file, the marker is a real Storage write.

const baseConfig: EthosConfig = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  apiKey: 'sk',
  personality: 'researcher',
};

describe('migrateSessionKeysIfNeeded — marker is gated on full coverage', () => {
  let realHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    // Redirect $HOME so `ethosDir()` (used by the orchestrator + the
    // session-sqlite path resolution) points at a fresh tmpdir.
    realHome = process.env.HOME;
    tempHome = mkdtempSync(join('/tmp', 'session-keys-orch-'));
    process.env.HOME = tempHome;
    expect(homedir()).toBe(tempHome); // belt + suspenders
  });

  afterEach(() => {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
    rmSync(tempHome, { recursive: true, force: true });
  });

  function ethosDir(): string {
    return join(homedir(), '.ethos');
  }

  function seedSessionsDb(rows: Array<{ key: string; platform: string }>): void {
    const dir = ethosDir();
    const dbPath = join(dir, 'sessions.db');
    // Set up the schema via the package's session store, then close
    // before letting the migration open its own connection.
    const store = new SQLiteSessionStore(dbPath);
    store.close();
    const db = new Database(dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO sessions (id, key, platform, model, provider, created_at, updated_at)
         VALUES (?, ?, ?, 'm', 'p', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      );
      for (const [i, r] of rows.entries()) {
        insert.run(`id-${i}`, r.key, r.platform);
      }
    } finally {
      db.close();
    }
  }

  it('does NOT write the marker when some legacy rows lack a configured bot for their platform', async () => {
    // The exact scenario Codex flagged: operator upgrades with both
    // telegram and slack session history, but only telegram bots are
    // configured today. Slack rows count as `skipped-no-bot`. Marker
    // must not be written — when slack is added later, migration runs.
    const storage = new FsStorage();
    await storage.mkdir(ethosDir());
    seedSessionsDb([
      { key: 'telegram:42', platform: 'telegram' },
      { key: 'slack:C001', platform: 'slack' },
    ]);

    const result = await migrateSessionKeysIfNeeded({
      storage,
      config: {
        ...baseConfig,
        telegram: {
          bots: [{ id: 't1key', token: 'tok', bind: { type: 'personality', name: 'researcher' } }],
        },
        // No slack apps configured.
      },
    });

    expect(result?.migrated).toBe(1); // telegram row
    expect(result?.skippedNoBot).toBe(1); // slack row

    const markerExists = await storage.exists(join(ethosDir(), '.session-key-migration-v1.done'));
    expect(markerExists).toBe(false);
  });

  it('writes the marker when every legacy row had a configured bot', async () => {
    const storage = new FsStorage();
    await storage.mkdir(ethosDir());
    seedSessionsDb([{ key: 'telegram:42', platform: 'telegram' }]);

    const result = await migrateSessionKeysIfNeeded({
      storage,
      config: {
        ...baseConfig,
        telegram: {
          bots: [{ id: 't1key', token: 'tok', bind: { type: 'personality', name: 'researcher' } }],
        },
      },
    });

    expect(result?.migrated).toBe(1);
    expect(result?.skippedNoBot).toBe(0);

    const markerExists = await storage.exists(join(ethosDir(), '.session-key-migration-v1.done'));
    expect(markerExists).toBe(true);
  });

  it('subsequent boot re-runs migration when the marker is missing (no-marker → another attempt)', async () => {
    const storage = new FsStorage();
    await storage.mkdir(ethosDir());
    seedSessionsDb([
      { key: 'telegram:42', platform: 'telegram' },
      { key: 'slack:C001', platform: 'slack' },
    ]);

    // First boot: only telegram configured. Marker NOT written.
    const first = await migrateSessionKeysIfNeeded({
      storage,
      config: {
        ...baseConfig,
        telegram: {
          bots: [{ id: 't1key', token: 'tok', bind: { type: 'personality', name: 'researcher' } }],
        },
      },
    });
    expect(first?.migrated).toBe(1);
    expect(first?.skippedNoBot).toBe(1);
    expect(await storage.exists(join(ethosDir(), '.session-key-migration-v1.done'))).toBe(false);

    // Second boot: operator added slack. Migration runs again, this
    // time covering the slack row.
    const second = await migrateSessionKeysIfNeeded({
      storage,
      config: {
        ...baseConfig,
        telegram: {
          bots: [{ id: 't1key', token: 'tok', bind: { type: 'personality', name: 'researcher' } }],
        },
        slack: {
          apps: [
            {
              id: 's1key',
              botToken: 'xoxb',
              appToken: 'xapp',
              signingSecret: 'sig',
              bind: { type: 'personality', name: 'researcher' },
            },
          ],
        },
      },
    });
    expect(second?.migrated).toBe(1); // slack row migrates now
    expect(second?.alreadyMigrated).toBe(1); // telegram row from first run
    expect(second?.skippedNoBot).toBe(0);
    expect(await storage.exists(join(ethosDir(), '.session-key-migration-v1.done'))).toBe(true);
  });

  it('short-circuits on a subsequent boot when the marker exists', async () => {
    const storage = new FsStorage();
    await storage.mkdir(ethosDir());
    // Pre-create the marker.
    await storage.write(join(ethosDir(), '.session-key-migration-v1.done'), 'done');
    // Even with legacy rows present, the marker short-circuits.
    seedSessionsDb([{ key: 'telegram:42', platform: 'telegram' }]);

    const result = await migrateSessionKeysIfNeeded({
      storage,
      config: { ...baseConfig },
    });
    expect(result).toBeNull(); // short-circuited
  });

  it('first-ever boot writes the marker (no sessions.db yet)', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());

    const result = await migrateSessionKeysIfNeeded({
      storage,
      config: { ...baseConfig },
    });
    expect(result).toEqual({
      migrated: 0,
      alreadyMigrated: 0,
      skippedNoBot: 0,
      quarantinedStale: 0,
    });
    expect(await storage.exists(join(ethosDir(), '.session-key-migration-v1.done'))).toBe(true);
  });
});
