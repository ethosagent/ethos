import { ethosDir, readConfig } from '@ethosagent/config';
import type { HistoryEntry, HistoryReadFilter, HistorySource } from '@ethosagent/wiring';
import { HistoryStore } from '@ethosagent/wiring';
import { writeJson } from '../json-output';
import { getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
};

const KNOWN_SOURCES: HistorySource[] = [
  'tool',
  'consolidation',
  'dream',
  'capture',
  'web-editor',
  'global-entry',
  'restore',
];

/**
 * `ethos memory history [--personality <id>] [--key MEMORY.md] [--source capture]
 * [--since 7d] [--limit 50] [--diff <n>] [--json]`
 *
 * Read-only view over the provenance history (§2.4). `--diff <n>` prints the
 * full diff of the Nth listed entry (1-based), fetching the content-addressed
 * before-state blob when the inline diff was truncated.
 */
export async function runMemoryHistory(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const jsonMode = args.includes('--json');

  const config = await readConfig(getStorage(), await getSecretsResolver());
  const personalityId = flag('--personality') ?? config?.personality ?? 'default';
  const scopeId = `personality:${personalityId}`;

  const store = new HistoryStore({ dataDir: ethosDir(), storage: getStorage() });

  const filter: HistoryReadFilter = {};
  const key = flag('--key');
  if (key) filter.key = key;
  const source = flag('--source');
  if (source) {
    if (!KNOWN_SOURCES.includes(source as HistorySource)) {
      console.error(`Unknown source "${source}". Known: ${KNOWN_SOURCES.join(', ')}`);
      process.exit(1);
    }
    filter.source = source as HistorySource;
  }
  const since = flag('--since');
  if (since) {
    const ms = parseSince(since);
    if (ms === null) {
      console.error(`Invalid --since "${since}". Use e.g. 7d, 12h, 30m.`);
      process.exit(1);
    }
    filter.sinceMs = Date.now() - ms;
  }
  const limitRaw = flag('--limit');
  filter.limit = limitRaw ? Math.max(1, Number(limitRaw) || 50) : 50;

  const { entries, corruptLines } = await store.read(scopeId, filter);

  const diffArg = flag('--diff');
  if (diffArg !== undefined) {
    const n = Number(diffArg);
    const entry = Number.isFinite(n) && n >= 1 ? entries[n - 1] : undefined;
    if (!entry) {
      console.error(`No entry #${diffArg} in the ${entries.length} listed entries.`);
      process.exit(1);
    }
    await printDiff(store, scopeId, entry, jsonMode);
    return;
  }

  if (jsonMode) {
    writeJson({ entries, corruptLines });
    return;
  }

  if (entries.length === 0) {
    console.log('No memory history yet.');
    if (corruptLines > 0)
      console.log(`${c.yellow}(${corruptLines} corrupt line(s) skipped)${c.reset}`);
    return;
  }

  entries.forEach((e, i) => {
    const when = new Date(e.ts).toISOString().slice(0, 16).replace('T', ' ');
    const hint = e.hint !== undefined ? ` hint=${e.hint}` : '';
    const blob = e.blob ? ' [blob]' : '';
    console.log(
      `${c.dim}#${i + 1}${c.reset} ${when} ${c.cyan}${e.source}${c.reset} ${c.bold}${e.key}${c.reset} ` +
        `${c.dim}[${e.actions.join(',')}]${c.reset} ${e.sizeBefore}→${e.sizeAfter}B${hint}${blob}`,
    );
  });
  if (corruptLines > 0) {
    console.log(`${c.yellow}(${corruptLines} corrupt line(s) skipped)${c.reset}`);
  }
  console.log(`${c.dim}Use --diff <n> to see one entry's full diff.${c.reset}`);
}

async function printDiff(
  store: HistoryStore,
  scopeId: string,
  entry: HistoryEntry,
  jsonMode: boolean,
): Promise<void> {
  const blobContent = entry.blob ? await store.readBlob(scopeId, entry.blob) : null;
  if (jsonMode) {
    writeJson({
      ts: entry.ts,
      key: entry.key,
      source: entry.source,
      actions: entry.actions,
      beforeHash: entry.beforeHash,
      afterHash: entry.afterHash,
      diff: entry.diff,
      ...(entry.blob ? { blob: entry.blob, beforeContent: blobContent } : {}),
    });
    return;
  }
  console.log(entry.diff);
  if (entry.blob) {
    console.log(`\n${c.dim}--- full before-state (blob sha256:${entry.blob}) ---${c.reset}`);
    console.log(blobContent ?? '(blob missing)');
  }
}

/** Parse a `7d` / `12h` / `30m` / `45s` duration into milliseconds; null if invalid. */
function parseSince(input: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}
