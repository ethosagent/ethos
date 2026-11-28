// Per-skill version history and lock for the flat markdown skills under
// `<dataDir>/skills/<id>.md` and `<dataDir>/personalities/<pid>/skills/<id>.md`.
//
// `SkillHistory` is the single writer of live flat-skill bytes and of their
// history (plan `skill-history-and-lock.md`, D4). `SkillsLibrary` (human CRUD)
// calls it directly; `promote()` / `rollback()` in `@ethosagent/learning-inbox`
// reach it through the `writeSkill` / `isSkillLocked` ports bound in
// `packages/wiring/src/learning-pipeline.ts` (`learningPromoteDeps`).
//
// On disk, beside each skill, through Storage only:
//
//   <skillsDir>/<id>.md                      live bytes (unchanged)
//   <skillsDir>/.history/<id>/versions.jsonl one row per version, append order = timeline
//   <skillsDir>/.history/<id>/<versionId>.md the bytes of that version (absent for a tombstone)
//   <skillsDir>/.history/<id>/lock.json      { locked, changedAt, changedBy }
//
// Dot-dirs are skipped by `UniversalScanner` and `SkillsInjector`, and
// `SkillsLibrary.listSkills` only reads names ending `.md`, so no loader sees it.
//
// Guarantees and their enforcers:
//   - A locked skill refuses agent-authored bytes: `writeAgentAuthored` checks the
//     lock before any byte is written. Pinned by 'writeAgentAuthored on a locked
//     skill' in `__tests__/skill-history.test.ts`. This is the one lock check.
//   - Humans are never blocked: `writeHuman` and `restore` do not read the lock.
//   - No bytes are lost to an outside edit: every write captures drift first
//     (`captureDrift`), and `versions()` does too. Pinned by 'drift capture'.
//   - A version is never rewritten in place: a restore appends a row.
//
// LIMITATIONS — named, not implied away:
//   - Rows are check-then-append. Two writers on one skill in the same instant can
//     both capture drift or interleave rows; no bytes are lost (each blob is its
//     own file) but the order can be off by one.
//   - A crash between the row append and the live write leaves a head row that
//     never went live; the next write's drift capture records the real live bytes
//     as `external`.
//   - `writeHuman` trusts its caller. The lock holds because agent-authored bytes
//     reach a skill only through `promote()`. `__tests__/skill-writers.test.ts` is a
//     TEXT scan that flags a Storage mutation naming a skill path outside this file;
//     a path built elsewhere and passed in as a bare variable is not caught, so it
//     narrows the writer set rather than proving it.

import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { assertSafeId, BoundaryError, EthosError, type Storage } from '@ethosagent/types';

export const SKILL_VERSION_SOURCES = [
  'learning',
  'learning-rollback',
  'web-edit',
  'web-import',
  'restore',
  'external',
] as const;
export type SkillVersionSource = (typeof SKILL_VERSION_SOURCES)[number];

/** Versions kept per skill (plan D8). The head and any `restoredFrom` target of a kept row are never pruned. */
export const SKILL_HISTORY_KEEP = 50;

export interface SkillVersion {
  versionId: string;
  /** ISO timestamp. */
  at: string;
  source: SkillVersionSource;
  actor: string;
  /** sha256 of the bytes; `null` is a tombstone (the skill was deleted). */
  hash: string | null;
  note?: string;
  candidateId?: string;
  restoredFrom?: string;
}

export interface SkillWriteMeta {
  source: SkillVersionSource;
  actor: string;
  note?: string;
  candidateId?: string;
  restoredFrom?: string;
}

export interface AgentWriteMeta {
  actor: string;
  note?: string;
  candidateId?: string;
}

export type AgentWriteResult = { ok: true; versionId: string } | { ok: false; code: 'locked' };

export interface SkillHistoryOptions {
  storage: Storage;
  /** `~/.ethos` (or `ETHOS_STATE_DIR`). */
  dataDir: string;
  now?: () => number;
}

interface LockRecord {
  locked: boolean;
  changedAt: string;
  changedBy: string;
}

export class SkillHistory {
  private readonly storage: Storage;
  private readonly dataDir: string;
  private readonly now: () => number;

  constructor(opts: SkillHistoryOptions) {
    this.storage = opts.storage;
    this.dataDir = opts.dataDir;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Write agent-authored bytes. Refuses (writing nothing) when the skill is
   * locked. The lock check lives here and nowhere else.
   */
  async writeAgentAuthored(
    dest: string,
    content: string,
    meta: AgentWriteMeta,
  ): Promise<AgentWriteResult> {
    const target = this.resolve(dest);
    if (await this.readLock(target)) return { ok: false, code: 'locked' };
    const { versionId } = await this.write(target, content, { source: 'learning', ...meta });
    return { ok: true, versionId };
  }

  /** Write (or, with `null`, delete) a skill on a human's behalf. No lock check (D5). */
  async writeHuman(
    dest: string,
    content: string | null,
    meta: SkillWriteMeta,
  ): Promise<{ versionId: string }> {
    return this.write(this.resolve(dest), content, meta);
  }

  /** The timeline, oldest first. Captures drift first, so an outside edit shows up. */
  async versions(dest: string): Promise<SkillVersion[]> {
    const target = this.resolve(dest);
    return this.captureDrift(target, await this.readRows(target));
  }

  /** The bytes of one version; `null` for an unknown id or a tombstone. */
  async readVersion(dest: string, versionId: string): Promise<string | null> {
    const target = this.resolve(dest);
    const rows = await this.readRows(target);
    if (!rows.some((r) => r.versionId === versionId && r.hash !== null)) return null;
    return this.storage.read(blobPath(target, versionId));
  }

  /** Make an older version live again, as a NEW version (nothing is rewritten in place). */
  async restore(dest: string, versionId: string, actor: string): Promise<{ versionId: string }> {
    const target = this.resolve(dest);
    const rows = await this.readRows(target);
    const row = rows.find((r) => r.versionId === versionId);
    if (!row) {
      throw new EthosError({
        code: 'SKILL_NOT_FOUND',
        cause: `Skill "${target.id}" has no version "${versionId}".`,
        action: `List its versions with \`ethos skills history ${target.id}\`.`,
      });
    }
    let bytes: string | null = null;
    if (row.hash !== null) {
      bytes = await this.storage.read(blobPath(target, versionId));
      if (bytes === null) {
        throw new EthosError({
          code: 'SKILL_NOT_FOUND',
          cause: `The bytes of version "${versionId}" of "${target.id}" are missing.`,
          action: 'Pick a different version.',
        });
      }
    }
    return this.write(target, bytes, { source: 'restore', actor, restoredFrom: versionId });
  }

  /**
   * What a listing shows beside a skill: its lock and how many versions it has
   * or is about to have. Unlike `versions()` it never writes, so listing skills
   * does not create `.history/` or record baselines. An outside edit not yet
   * captured counts as one more version, which is what `versions()` would then show.
   */
  async summary(dest: string): Promise<{ locked: boolean; versionCount: number }> {
    const target = this.resolve(dest);
    const rows = await this.readRows(target);
    const live = await this.storage.read(target.live);
    const liveHash = live === null ? null : sha256Hex(live);
    const head = rows.at(-1);
    const pending = head === undefined ? live !== null : head.hash !== liveHash;
    return {
      locked: await this.readLock(target),
      versionCount: rows.length + (pending ? 1 : 0),
    };
  }

  async isLocked(dest: string): Promise<boolean> {
    return this.readLock(this.resolve(dest));
  }

  async setLock(dest: string, locked: boolean, actor: string): Promise<void> {
    const target = this.resolve(dest);
    await this.storage.mkdir(target.historyDir);
    const record: LockRecord = {
      locked,
      changedAt: new Date(this.now()).toISOString(),
      changedBy: actor,
    };
    await this.storage.writeAtomic(lockPath(target), `${JSON.stringify(record, null, 2)}\n`);
  }

  // ---------------------------------------------------------------------------

  private async write(
    target: Target,
    content: string | null,
    meta: SkillWriteMeta,
  ): Promise<{ versionId: string }> {
    // (1) drift capture
    let rows = await this.captureDrift(target, await this.readRows(target));
    await this.storage.mkdir(target.historyDir);
    // (2) the version blob, (3) the row
    const row = this.makeRow(rows, content, meta);
    if (content !== null) await this.storage.writeAtomic(blobPath(target, row.versionId), content);
    await this.appendRow(target, row);
    rows = [...rows, row];
    // (4) the live file
    if (content !== null) {
      await this.storage.mkdir(target.dir);
      await this.storage.writeAtomic(target.live, content);
    } else if (await this.storage.exists(target.live)) {
      await this.storage.remove(target.live);
    }
    // (5) prune
    await this.prune(target, rows);
    return { versionId: row.versionId };
  }

  /** Append an `external` row when the live bytes differ from the head row (D10). */
  private async captureDrift(target: Target, rows: SkillVersion[]): Promise<SkillVersion[]> {
    const live = await this.storage.read(target.live);
    const liveHash = live === null ? null : sha256Hex(live);
    const head = rows.at(-1);
    if (head === undefined ? live === null : head.hash === liveHash) return rows;
    await this.storage.mkdir(target.historyDir);
    const row = this.makeRow(rows, live, { source: 'external', actor: 'external' });
    if (live !== null) await this.storage.writeAtomic(blobPath(target, row.versionId), live);
    await this.appendRow(target, row);
    return [...rows, row];
  }

  private makeRow(
    rows: SkillVersion[],
    content: string | null,
    meta: SkillWriteMeta,
  ): SkillVersion {
    const hash = content === null ? null : sha256Hex(content);
    const taken = new Set(rows.map((r) => r.versionId));
    let ms = this.now();
    let versionId = versionIdFor(ms, hash);
    while (taken.has(versionId)) versionId = versionIdFor(++ms, hash);
    return {
      versionId,
      at: new Date(ms).toISOString(),
      source: meta.source,
      actor: meta.actor,
      hash,
      ...(meta.note !== undefined ? { note: meta.note } : {}),
      ...(meta.candidateId !== undefined ? { candidateId: meta.candidateId } : {}),
      ...(meta.restoredFrom !== undefined ? { restoredFrom: meta.restoredFrom } : {}),
    };
  }

  private async appendRow(target: Target, row: SkillVersion): Promise<void> {
    await this.storage.append(rowsPath(target), `${JSON.stringify(row)}\n`);
  }

  private async readRows(target: Target): Promise<SkillVersion[]> {
    const raw = await this.storage.read(rowsPath(target));
    if (raw === null) return [];
    const rows: SkillVersion[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a torn final line from a crash; the next drift capture re-records the bytes
      }
      const row = toVersion(parsed);
      if (row) rows.push(row);
    }
    return rows;
  }

  private async prune(target: Target, rows: SkillVersion[]): Promise<void> {
    if (rows.length <= SKILL_HISTORY_KEEP) return;
    const kept = new Set(rows.slice(-SKILL_HISTORY_KEEP).map((r) => r.versionId));
    for (const row of rows.slice(-SKILL_HISTORY_KEEP)) {
      if (row.restoredFrom !== undefined) kept.add(row.restoredFrom);
    }
    const survivors = rows.filter((r) => kept.has(r.versionId));
    if (survivors.length === rows.length) return;
    await this.storage.writeAtomic(
      rowsPath(target),
      survivors.map((r) => `${JSON.stringify(r)}\n`).join(''),
    );
    for (const row of rows) {
      if (kept.has(row.versionId) || row.hash === null) continue;
      await this.storage.remove(blobPath(target, row.versionId));
    }
  }

  private async readLock(target: Target): Promise<boolean> {
    const raw = await this.storage.read(lockPath(target));
    if (raw === null) return false;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) && parsed.locked === true;
    } catch {
      // An unreadable lock file fails closed: the human set it, so keep agents out.
      return true;
    }
  }

  /** Validate `dest` and derive its history paths. Throws `BoundaryError` for anything else. */
  private resolve(dest: string): Target {
    const allowed = [
      join(this.dataDir, 'skills'),
      join(this.dataDir, 'personalities', '<id>', 'skills'),
    ];
    const dir = dirname(dest);
    const file = basename(dest);
    const stem = file.endsWith('.md') ? file.slice(0, -3) : '';
    try {
      assertSafeId(stem, 'skillId');
    } catch {
      throw new BoundaryError('write', dest, allowed, 'not a skill file');
    }
    if (dir !== join(this.dataDir, 'skills')) {
      const prefix = join(this.dataDir, 'personalities');
      const rel = dir.startsWith(`${prefix}/`) ? dir.slice(prefix.length + 1).split('/') : [];
      const [pid, leaf] = rel;
      let safe = rel.length === 2 && leaf === 'skills' && pid !== undefined;
      if (safe && pid !== undefined) {
        try {
          assertSafeId(pid, 'personalityId');
        } catch {
          safe = false;
        }
      }
      if (!safe) throw new BoundaryError('write', dest, allowed, 'not a skills directory');
    }
    return { live: dest, dir, id: stem, historyDir: join(dir, '.history', stem) };
  }
}

interface Target {
  live: string;
  dir: string;
  id: string;
  historyDir: string;
}

const rowsPath = (t: Target): string => join(t.historyDir, 'versions.jsonl');
const lockPath = (t: Target): string => join(t.historyDir, 'lock.json');
const blobPath = (t: Target, versionId: string): string => join(t.historyDir, `${versionId}.md`);

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** `<UTC ISO compact>-<sha256 first 8>`; a tombstone has no bytes to hash. */
function versionIdFor(ms: number, hash: string | null): string {
  const stamp = new Date(ms).toISOString().replace(/[-:]/g, '');
  return `${stamp}-${hash === null ? '00000000' : hash.slice(0, 8)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toVersion(v: unknown): SkillVersion | null {
  if (!isRecord(v)) return null;
  const { versionId, at, source, actor, hash, note, candidateId, restoredFrom } = v;
  if (typeof versionId !== 'string' || typeof at !== 'string' || typeof actor !== 'string') {
    return null;
  }
  if (hash !== null && typeof hash !== 'string') return null;
  const knownSource = SKILL_VERSION_SOURCES.find((s) => s === source);
  if (knownSource === undefined) return null;
  return {
    versionId,
    at,
    source: knownSource,
    actor,
    hash,
    ...(typeof note === 'string' ? { note } : {}),
    ...(typeof candidateId === 'string' ? { candidateId } : {}),
    ...(typeof restoredFrom === 'string' ? { restoredFrom } : {}),
  };
}

/**
 * The three ports `promote()` / `rollback()` take (`PromoteDeps.isSkillLocked`,
 * `writeSkill`, `rollbackSkill` in `@ethosagent/learning-inbox`), bound to one
 * `SkillHistory`. learning-inbox sits below skills, so it cannot import this
 * class; `learningPromoteDeps` (packages/wiring/src/learning-pipeline.ts) spreads
 * this into `PromoteDeps`. `rollbackSkill` is a human verb, so it skips the lock.
 */
export function skillHistoryPromotePorts(history: SkillHistory): {
  isSkillLocked(destination: string): Promise<boolean>;
  writeSkill(destination: string, content: string, meta: AgentWriteMeta): Promise<AgentWriteResult>;
  rollbackSkill(
    destination: string,
    content: string | null,
    meta: { actor: string; candidateId: string; note?: string },
  ): Promise<void>;
} {
  return {
    isSkillLocked: (destination) => history.isLocked(destination),
    writeSkill: (destination, content, meta) =>
      history.writeAgentAuthored(destination, content, meta),
    rollbackSkill: async (destination, content, meta) => {
      await history.writeHuman(destination, content, { source: 'learning-rollback', ...meta });
    },
  };
}

const MAX_DIFF_CELLS = 4_000_000;

/**
 * A line diff of two skill versions for the CLI: each line prefixed `' '`,
 * `'-'` or `'+'`. `null` is a missing file. The web uses `unifiedDiff`
 * (apps/web/src/lib/learning.ts) instead — the CLI cannot import web code (D14).
 */
export function diffSkillVersions(before: string | null, after: string | null): string {
  const a = toLines(before);
  const b = toLines(after);
  const n = a.length;
  const m = b.length;
  const out: string[] = [];
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
    for (const l of a) out.push(`-${l}`);
    for (const l of b) out.push(`+${l}`);
    return out.join('\n');
  }
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  for (; i < n; i++) out.push(`-${a[i]}`);
  for (; j < m; j++) out.push(`+${b[j]}`);
  return out.join('\n');
}

function toLines(s: string | null): string[] {
  if (s === null || s === '') return [];
  const lines = s.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
