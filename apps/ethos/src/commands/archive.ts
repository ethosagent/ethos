// ethos archive restore <YYYY-MM>
// ethos archive prune --older-than <duration>
//
// Companion to `ethos data archive` (which creates archives).
// This command handles restore and prune operations on the archive tier.

import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import {
  listArchives,
  parseDuration,
  pruneArchives,
  restoreArchive,
} from '@ethosagent/observability-sqlite';
import { getStorage } from '../wiring';

export async function runArchive(sub: string, argv: string[]): Promise<void> {
  const dir = ethosDir();
  const dbPath = join(dir, 'observability.db');
  const archiveDir = join(dir, 'archive');
  const storage = getStorage();

  // ── list ────────────────────────────────────────────────────────────────
  if (sub === 'list' || sub === '') {
    const archives = await listArchives(storage, archiveDir);
    if (archives.length === 0) {
      console.log('No archives found.');
      return;
    }
    console.log('\nArchives — ~/.ethos/archive/');
    console.log('══════════════════════════════');
    for (const { month } of archives) {
      console.log(`  ${month}`);
    }
    console.log();
    return;
  }

  // ── restore <YYYY-MM> ────────────────────────────────────────────────────
  if (sub === 'restore') {
    const month = argv[0];
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      console.log('Usage: ethos archive restore <YYYY-MM>');
      process.exit(1);
    }
    console.log(`Restoring archive ${month}...`);
    try {
      const result = await restoreArchive(dbPath, storage, archiveDir, month);
      console.log(
        `Restored ${result.traces} trace(s), ${result.spans} span(s), ${result.events} event(s), ${result.snapshots} snapshot(s) from ${month}.`,
      );
    } catch (e) {
      console.error(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    return;
  }

  // ── prune --older-than <duration> ────────────────────────────────────────
  if (sub === 'prune') {
    let olderThan: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--older-than' && argv[i + 1]) {
        olderThan = argv[i + 1];
        i++;
      }
    }
    if (!olderThan) {
      console.log('Usage: ethos archive prune --older-than <duration>  (e.g. 730d)');
      process.exit(1);
    }
    let olderThanMs: number | null;
    try {
      olderThanMs = parseDuration(olderThan);
    } catch {
      console.error(`Invalid duration: "${olderThan}". Use e.g. 730d, 2y.`);
      process.exit(1);
    }
    if (olderThanMs === null) {
      console.log('Duration "forever" makes no sense for prune — nothing to do.');
      return;
    }
    const removed = await pruneArchives(storage, archiveDir, olderThanMs);
    if (removed === 0) {
      console.log('No archives old enough to prune.');
    } else {
      console.log(`Pruned ${removed} archive file(s) older than ${olderThan}.`);
    }
    return;
  }

  console.log('Usage: ethos archive [list | restore <YYYY-MM> | prune --older-than <duration>]');
}
