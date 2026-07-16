import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { createTwoFilesPatch } from 'diff';
import type { HistoryEntry, HistoryReadFilter, HistoryReadResult, HistorySource } from './types';

/** Default inline-diff cap. Beyond this the before-state is spilled to a blob. */
const DEFAULT_DIFF_CAP_BYTES = 4096;

const HISTORY_FILE = 'memory-history.jsonl';
const BLOB_DIR = 'history-blobs';

export interface HistoryStoreOptions {
  /**
   * Root data directory the wrapped provider uses. For the personality /
   * global provider this is `~/.ethos`; for a team provider it is that
   * team's memory dir — the same `dir` the wrapped MarkdownFileMemoryProvider
   * was constructed with, so scope resolution stays in lockstep.
   */
  dataDir: string;
  storage: Storage;
  /** Inline-diff cap in bytes (default 4096). Diffs above this spill to a blob. */
  diffCapBytes?: number;
}

export interface RecordInput {
  scopeId: string;
  key: string;
  actions: string[];
  source: HistorySource;
  sessionId: string;
  sessionKey: string;
  /** Pre-mutation content ('' when the key was absent). */
  before: string;
  /** Post-mutation content ('' when the key was deleted). */
  after: string;
  hint?: number;
  /** Normalized-fact hashes — set only by the capture runner (pillar B). */
  captureHashes?: string[];
}

/**
 * Append-only provenance history for memory mutations. JSONL, one entry per
 * line, in the scope dir — `cat`-able, greppable, diffable (§2.2). All I/O
 * goes through the injected Storage; no raw `node:fs`, so it works against
 * InMemoryStorage in tests.
 */
export class HistoryStore {
  private readonly dataDir: string;
  private readonly storage: Storage;
  private readonly diffCap: number;

  constructor(opts: HistoryStoreOptions) {
    this.dataDir = opts.dataDir;
    this.storage = opts.storage;
    this.diffCap = opts.diffCapBytes ?? DEFAULT_DIFF_CAP_BYTES;
  }

  /**
   * Resolve the scope directory. Mirrors MarkdownFileMemoryProvider's routing
   * so the history file lands next to the memory files it records. `global`
   * (the GlobalMemoryStore root entries) and `team:<id>` both resolve to the
   * store's own `dataDir`.
   */
  scopeDir(scopeId: string): string {
    if (scopeId === 'global') return this.dataDir;
    if (scopeId.startsWith('personality:')) {
      const id = scopeId.slice('personality:'.length);
      if (!id || !isSafeId(id)) throw new Error(`unrecognised memory scope: ${scopeId}`);
      return join(this.dataDir, 'personalities', id);
    }
    if (scopeId.startsWith('team:')) {
      const id = scopeId.slice('team:'.length);
      if (!id || !isSafeId(id)) throw new Error(`unrecognised memory scope: ${scopeId}`);
      return this.dataDir;
    }
    if (scopeId.startsWith('user:')) {
      const id = scopeId.slice('user:'.length);
      if (!id || !isSafeId(id)) throw new Error(`unrecognised memory scope: ${scopeId}`);
      return join(this.dataDir, 'users', id);
    }
    throw new Error(`unrecognised memory scope: ${scopeId}`);
  }

  historyPath(scopeId: string): string {
    return join(this.scopeDir(scopeId), HISTORY_FILE);
  }

  private blobPath(scopeId: string, blob: string): string {
    return join(this.scopeDir(scopeId), BLOB_DIR, `${blob}.md`);
  }

  /**
   * Record one mutation as a single history entry. Returns the entry, or
   * `null` when nothing changed (before === after) — a no-op sync (e.g. a
   * `remove` that matched nothing, or a `replace` with identical content)
   * writes no history line.
   */
  async record(input: RecordInput): Promise<HistoryEntry | null> {
    if (input.before === input.after) return null;

    const scopeDir = this.scopeDir(input.scopeId);
    await this.storage.mkdir(scopeDir);

    const diffText = createTwoFilesPatch(input.key, input.key, input.before, input.after, '', '');

    const entry: HistoryEntry = {
      ts: Date.now(),
      scopeId: input.scopeId,
      key: input.key,
      actions: input.actions,
      source: input.source,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      beforeHash: `sha256:${sha256(input.before)}`,
      afterHash: `sha256:${sha256(input.after)}`,
      diff: diffText,
      sizeBefore: Buffer.byteLength(input.before),
      sizeAfter: Buffer.byteLength(input.after),
    };
    if (input.hint !== undefined) entry.hint = input.hint;
    if (input.captureHashes && input.captureHashes.length > 0) {
      entry.captureHashes = input.captureHashes;
    }

    if (Buffer.byteLength(diffText) > this.diffCap) {
      // Spill the FULL before-content to a content-addressed blob so the
      // truncated inline diff never orphans recoverable state (§2.1). The
      // blob is keyed by the before-content hash — identical before-states
      // dedupe to one blob.
      const blob = sha256(input.before);
      const blobPath = this.blobPath(input.scopeId, blob);
      if (!(await this.storage.exists(blobPath))) {
        await this.storage.mkdir(join(scopeDir, BLOB_DIR));
        await this.storage.writeAtomic(blobPath, input.before);
      }
      entry.blob = blob;
      entry.diff = `${truncateBytes(diffText, this.diffCap)}\n… [diff truncated; before-state in blob sha256:${blob}]`;
    }

    await this.storage.append(this.historyPath(input.scopeId), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  /** Read the full before-content referenced by an entry's `blob`. */
  async readBlob(scopeId: string, blob: string): Promise<string | null> {
    return this.storage.read(this.blobPath(scopeId, blob));
  }

  /**
   * Tolerant reader: parses the live history file plus any rotated
   * `memory-history-YYYY-MM.jsonl` archives in the scope dir. A torn or
   * malformed line is skipped and counted in `corruptLines`.
   */
  async read(scopeId: string, filter?: HistoryReadFilter): Promise<HistoryReadResult> {
    const scopeDir = this.scopeDir(scopeId);
    const names = await this.storage.list(scopeDir);
    const files = [HISTORY_FILE, ...names.filter(isRotatedHistoryFile).sort()];

    const entries: HistoryEntry[] = [];
    let corruptLines = 0;
    for (const name of files) {
      const raw = await this.storage.read(join(scopeDir, name));
      if (raw === null) continue;
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue;
        const parsed = parseEntry(line);
        if (parsed === null) {
          corruptLines++;
          continue;
        }
        entries.push(parsed);
      }
    }

    let filtered = entries;
    if (filter?.key) filtered = filtered.filter((e) => e.key === filter.key);
    if (filter?.source) filtered = filtered.filter((e) => e.source === filter.source);
    if (filter?.sinceMs !== undefined) {
      const since = filter.sinceMs;
      filtered = filtered.filter((e) => e.ts >= since);
    }
    filtered.sort((a, b) => a.ts - b.ts);
    if (filter?.limit !== undefined && filtered.length > filter.limit) {
      filtered = filtered.slice(filtered.length - filter.limit);
    }

    return { entries: filtered, corruptLines };
  }

  /**
   * Month-rotation (§2.2). Moves every live-file entry from a month strictly
   * before `now`'s month into `memory-history-<month>.jsonl` and rewrites the
   * live file with only the current month's lines. Single-rotator: only the
   * nightly pass calls this. Rotated files are never auto-deleted (open
   * question 3); content-addressed blobs stay in the shared `history-blobs/`
   * dir and travel with no month, since nothing is pruned.
   */
  async rotate(scopeId: string, now = new Date()): Promise<{ rotated: number }> {
    const path = this.historyPath(scopeId);
    const raw = await this.storage.read(path);
    if (raw === null) return { rotated: 0 };

    const currentMonth = monthKey(now.getTime());
    const scopeDir = this.scopeDir(scopeId);
    const keep: string[] = [];
    const byMonth = new Map<string, string[]>();

    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      const parsed = parseEntry(line);
      // Malformed lines are kept in the live file — the tolerant reader copes,
      // and rotation must never silently drop bytes it cannot classify.
      if (parsed === null) {
        keep.push(line);
        continue;
      }
      const month = monthKey(parsed.ts);
      if (month >= currentMonth) {
        keep.push(line);
      } else {
        const list = byMonth.get(month) ?? [];
        list.push(line);
        byMonth.set(month, list);
      }
    }

    if (byMonth.size === 0) return { rotated: 0 };

    let rotated = 0;
    for (const [month, lines] of byMonth) {
      await this.storage.append(
        join(scopeDir, `memory-history-${month}.jsonl`),
        `${lines.join('\n')}\n`,
      );
      rotated += lines.length;
    }
    await this.storage.writeAtomic(path, keep.length > 0 ? `${keep.join('\n')}\n` : '');
    return { rotated };
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  // Slice by chars until under the byte budget (utf-8-safe: never emits a
  // partial multibyte sequence because we cut on a char boundary).
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > maxBytes) end--;
  return text.slice(0, end);
}

function parseEntry(line: string): HistoryEntry | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (
      typeof obj.ts !== 'number' ||
      typeof obj.scopeId !== 'string' ||
      typeof obj.key !== 'string' ||
      typeof obj.source !== 'string'
    ) {
      return null;
    }
    return obj as unknown as HistoryEntry;
  } catch {
    return null;
  }
}

/** 'YYYY-MM' for an epoch-ms timestamp (local time, matching observability). */
function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isRotatedHistoryFile(name: string): boolean {
  return /^memory-history-\d{4}-\d{2}\.jsonl$/.test(name);
}

function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}
