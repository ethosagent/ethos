// ethos archive [list] [--json]
// ethos archive restore <YYYY-MM> [--json]
// ethos archive prune --older-than <duration> [--json]
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
import { sayFor, splitJson, writeJson, writeJsonError } from '../json-output';
import { getStorage } from '../wiring';

export async function runArchive(subArg: string, rest: string[]): Promise<void> {
  // index.ts hands over `args[1] ?? 'list'`, so a bare `ethos archive --json` arrives as the sub:
  // strip the flag from the whole vector, wherever it sits, and default the sub afterwards.
  const { json, args } = splitJson([subArg, ...rest]);
  const sub = args[0] ?? 'list';
  const argv = args.slice(1);
  const say = sayFor(json);
  const dir = ethosDir();
  const dbPath = join(dir, 'observability.db');
  const archiveDir = join(dir, 'archive');
  const storage = getStorage();

  // ── list ────────────────────────────────────────────────────────────────
  if (sub === 'list' || sub === '') {
    const archives = await listArchives(storage, archiveDir);
    if (json) {
      writeJson({ ok: true, archives: archives.map((a) => a.month) });
      return;
    }
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
      if (json) writeJsonError('INVALID_INPUT', 'Usage: ethos archive restore <YYYY-MM> [--json]');
      console.log('Usage: ethos archive restore <YYYY-MM> [--json]');
      process.exit(1);
    }
    say(`Restoring archive ${month}...`);
    try {
      const result = await restoreArchive(dbPath, storage, archiveDir, month);
      if (json) {
        writeJson({ ok: true, month, restored: result });
        return;
      }
      console.log(
        `Restored ${result.traces} trace(s), ${result.spans} span(s), ${result.events} event(s), ${result.snapshots} snapshot(s) from ${month}.`,
      );
    } catch (e) {
      if (json) throw e;
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
      if (json) {
        writeJsonError(
          'INVALID_INPUT',
          'Usage: ethos archive prune --older-than <duration>  (e.g. 730d) [--json]',
        );
      }
      console.log('Usage: ethos archive prune --older-than <duration>  (e.g. 730d) [--json]');
      process.exit(1);
    }
    let olderThanMs: number | null;
    try {
      olderThanMs = parseDuration(olderThan);
    } catch {
      if (json)
        writeJsonError('INVALID_INPUT', `Invalid duration: "${olderThan}". Use e.g. 730d, 2y.`);
      console.error(`Invalid duration: "${olderThan}". Use e.g. 730d, 2y.`);
      process.exit(1);
    }
    if (olderThanMs === null) {
      if (json) {
        writeJson({ ok: true, removed: 0 });
        return;
      }
      console.log('Duration "forever" makes no sense for prune — nothing to do.');
      return;
    }
    const removed = await pruneArchives(storage, archiveDir, olderThanMs);
    if (json) {
      writeJson({ ok: true, removed });
      return;
    }
    if (removed === 0) {
      console.log('No archives old enough to prune.');
    } else {
      console.log(`Pruned ${removed} archive file(s) older than ${olderThan}.`);
    }
    return;
  }

  const usage =
    'Usage: ethos archive [list | restore <YYYY-MM> | prune --older-than <duration>] [--json]';
  if (json) writeJsonError('INVALID_INPUT', usage);
  console.log(usage);
}
