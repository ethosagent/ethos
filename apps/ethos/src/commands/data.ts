import { rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  BlobStore,
  getSqliteStats,
  mergeRetentionConfig,
  ObservabilityService,
  pruneObservabilityByPath,
  SQLiteObservabilityStore,
} from '@ethosagent/observability-sqlite';
import { RETENTION_DEFAULTS } from '@ethosagent/types';
import { ethosDir, readConfig } from '../config';
import { getStorage } from '../wiring';

// ---------------------------------------------------------------------------
// ethos data stats
// ethos data prune [--dry-run] [--category <name>] [--older-than <duration>]
// ethos data reset [--dry-run] [--blobs-only]
// ethos data archive list
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function dirSize(path: string): Promise<number> {
  const storage = getStorage();
  try {
    let total = 0;
    const entries = await storage.listEntries(path);
    for (const e of entries) {
      const p = join(path, e.name);
      if (e.isDir) {
        total += await dirSize(p);
      } else {
        total += fileSize(p);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function countFiles(path: string, ext?: string): Promise<number> {
  const storage = getStorage();
  try {
    const names = await storage.list(path);
    let count = 0;
    for (const name of names) {
      if (!ext || name.endsWith(ext)) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function parseFlags(argv: string[]): {
  dryRun: boolean;
  blobsOnly: boolean;
  category?: string;
  olderThan?: string;
  personality?: string;
  positional: string[];
} {
  const positional: string[] = [];
  let dryRun = false;
  let blobsOnly = false;
  let category: string | undefined;
  let olderThan: string | undefined;
  let personality: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--blobs-only') {
      blobsOnly = true;
    } else if (a === '--category' && argv[i + 1]) {
      category = argv[i + 1];
      i++;
    } else if (a === '--older-than' && argv[i + 1]) {
      olderThan = argv[i + 1];
      i++;
    } else if ((a === '--personality' || a === '-p') && argv[i + 1]) {
      personality = argv[i + 1];
      i++;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  return { dryRun, blobsOnly, category, olderThan, personality, positional };
}

async function runStats(): Promise<void> {
  const dir = ethosDir();

  const sessDbPath = join(dir, 'sessions.db');
  const obsDbPath = join(dir, 'observability.db');
  const blobsDir = join(dir, 'blobs');
  const archiveDir = join(dir, 'archive');

  const sessSize = fileSize(sessDbPath);
  const obsSize = fileSize(obsDbPath);
  const [blobsSize, archiveSize, blobCount, archiveCount] = await Promise.all([
    dirSize(blobsDir),
    dirSize(archiveDir),
    countFiles(blobsDir),
    countFiles(archiveDir, '.tar.gz'),
  ]);

  console.log('\nData stats — ~/.ethos/');
  console.log('══════════════════════');
  console.log('WARM CRITICAL PATH');

  let sessDbExtra = '';
  const sessStats = getSqliteStats(sessDbPath);
  if (sessStats) {
    sessDbExtra =
      sessStats.totalBytes === sessSize ? '' : ` (pragma: ${formatBytes(sessStats.totalBytes)})`;
  }
  console.log(`  sessions.db      ${formatBytes(sessSize)}${sessDbExtra}`);

  console.log('COLD DROPPABLE PATH');
  console.log(`  observability.db ${formatBytes(obsSize)}`);
  console.log(`  blobs/           ${formatBytes(blobsSize)}  (${blobCount} files)`);
  console.log(`  archive/         ${formatBytes(archiveSize)}  (${archiveCount} .tar.gz)`);
  console.log();
}

async function runPrune(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const storage = getStorage();
  const config = await readConfig(storage);

  const globalRetention = config?.retention;
  const baseConfig = mergeRetentionConfig(RETENTION_DEFAULTS, globalRetention ?? {});
  const personalityRetention = flags.personality
    ? config?.personalitiesConfig?.[flags.personality]?.retention
    : undefined;
  const merged = personalityRetention
    ? mergeRetentionConfig(baseConfig, personalityRetention)
    : baseConfig;

  // If --older-than and --category, override the specific category for this run
  const effectiveConfig = { ...merged };
  if (flags.olderThan && flags.category) {
    const cat = flags.category;
    const dur = flags.olderThan;
    if (cat === 'traces') effectiveConfig.traces = dur;
    else if (cat === 'spans') effectiveConfig.spans = dur;
    else if (cat === 'events.error')
      effectiveConfig.events = { ...effectiveConfig.events, error: dur };
    else if (cat === 'events.audit')
      effectiveConfig.events = { ...effectiveConfig.events, audit: dur };
    else if (cat === 'events.channel')
      effectiveConfig.events = { ...effectiveConfig.events, channel: dur };
    else if (cat === 'events.install')
      effectiveConfig.events = { ...effectiveConfig.events, install: dur };
  }

  const dir = ethosDir();
  const obsDbPath = join(dir, 'observability.db');

  if (!fileSize(obsDbPath)) {
    console.log('No observability.db found — nothing to prune.');
    return;
  }

  const result = pruneObservabilityByPath(obsDbPath, effectiveConfig, { dryRun: flags.dryRun });
  const prefix = flags.dryRun ? 'Would prune' : 'Pruned';
  console.log(
    `${prefix} ${result.traces} trace(s), ${result.spans} span(s), ${result.events} event(s), ${result.snapshots} orphaned snapshot(s).`,
  );
  if (flags.dryRun) {
    console.log('(Dry run — no changes made)');
  }
}

async function runReset(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const dir = ethosDir();

  const obsDbPath = join(dir, 'observability.db');
  const obsWalPath = `${obsDbPath}-wal`;
  const obsShmPath = `${obsDbPath}-shm`;
  const blobsDir = join(dir, 'blobs');
  const archiveDir = join(dir, 'archive');

  const obsSize = fileSize(obsDbPath);
  const [blobsSize, archiveSize] = await Promise.all([dirSize(blobsDir), dirSize(archiveDir)]);

  console.log('\nThis will delete:');
  if (!flags.blobsOnly) {
    console.log(`  observability.db  ${formatBytes(obsSize)}`);
    console.log(`  archive/          ${formatBytes(archiveSize)}`);
  }
  console.log(`  blobs/            ${formatBytes(blobsSize)}`);
  console.log('\n  sessions.db will be preserved.');
  console.log();

  if (flags.dryRun) {
    console.log('(Dry run — no changes made)');
    return;
  }

  // Prompt for confirmation
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question('Type RESET to confirm: ', resolve);
  });
  rl.close();

  if (answer.trim() !== 'RESET') {
    console.log('Cancelled.');
    return;
  }

  if (!flags.blobsOnly) {
    for (const p of [obsDbPath, obsWalPath, obsShmPath]) {
      try {
        unlinkSync(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    try {
      rmSync(archiveDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  try {
    rmSync(blobsDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  if (!flags.blobsOnly) {
    // Recreate the observability.db with all tables
    const storage = getStorage();
    const blobStore = new BlobStore(join(dir, 'blobs'), storage);
    const store = new SQLiteObservabilityStore(obsDbPath);
    try {
      const svc = new ObservabilityService(store, blobStore);
      svc.recordEvent({
        category: 'install.event',
        severity: 'info',
        code: 'data.reset',
        cause: 'User-initiated reset',
      });
    } finally {
      store.close();
    }
    console.log('\nReset complete. observability.db recreated.');
    console.log('  observability.db recreated with empty schema');
    console.log('  archive/ removed');
  } else {
    console.log('\nReset complete. blobs/ removed.');
  }
  console.log('  blobs/ removed');
  console.log('  sessions.db untouched');
  console.log();
}

async function runArchiveList(): Promise<void> {
  const dir = ethosDir();
  const archiveDir = join(dir, 'archive');
  const storage = getStorage();

  const all = await storage.list(archiveDir);
  const entries = all.filter((f) => f.endsWith('.tar.gz')).sort();

  if (entries.length === 0) {
    console.log('No archives found.');
    return;
  }

  console.log('\nArchives — ~/.ethos/archive/');
  console.log('══════════════════════════════');
  for (const name of entries) {
    const size = fileSize(join(archiveDir, name));
    console.log(`  ${name.padEnd(40)} ${formatBytes(size)}`);
  }
  console.log();
}

export async function runData(sub: string, argv: string[]): Promise<void> {
  if (sub === 'stats' || sub === '') {
    await runStats();
    return;
  }

  if (sub === 'prune') {
    await runPrune(argv);
    return;
  }

  if (sub === 'reset') {
    await runReset(argv);
    return;
  }

  if (sub === 'archive') {
    const archiveSub = argv[0] ?? 'list';
    if (archiveSub === 'list') {
      await runArchiveList();
    } else {
      console.log('Usage: ethos data archive list');
    }
    return;
  }

  console.log(
    'Usage: ethos data [stats | prune [--dry-run] | reset [--dry-run] [--blobs-only] | archive list]',
  );
}
