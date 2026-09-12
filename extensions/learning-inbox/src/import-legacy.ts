// The one-time drain of the four queues the inbox replaces (L-T1).
//
//   <dataDir>/skills/pending/*.md            the eval-driven SkillEvolver queue
//   <dataDir>/skills/.pending/*.md           chat `skill_propose` (no personality)
//   <dataDir>/skills/.pending/<pid>/*.md     the live fork and the nightly pass
//   <dataDir>/learning/pending-expression/<pid>.json   B-T1's Expression queue
//
// The three skill queues arrive as `origin: 'legacy'`; a queued Expression is a
// nightly draft and keeps `origin: 'nightly'` (L-D2).
//
// Idempotence is belt and braces on purpose. The import DRAINS each source, so
// a second run over the same tree finds nothing; and it writes a marker when it
// finishes, so it does not walk four directories on every boot. The marker is
// written only after a complete pass, so a run that throws half way leaves the
// remainder to be picked up next time.

import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { learningDir, legacyImportMarkerPath } from './paths';
import { type LearningCandidate, sha256Hex, submitCandidate, updateCandidate } from './store';

/**
 * Same charset `createSkillProposeTool` enforces when it WRITES a
 * `target_file`. A legacy file that carries anything else was hand-edited;
 * `target_file` becomes a path segment, so it is not trusted here either.
 */
const TARGET_FILE_RE = /^[a-zA-Z0-9_-]+(\.md)?$/;

/** Personality directory names under `skills/.pending/`, matching `assertSafeId`. */
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface LegacyImportDeps {
  storage: Storage;
  /** `~/.ethos` (or `ETHOS_STATE_DIR`). */
  dataDir: string;
  /**
   * Live directory a promoted skill for this personality lands in. Callers
   * pass `(pid) => liveSkillDir(dataDir, pid, scopeOf(pid))` from
   * `@ethosagent/skill-evolver` — resolving it here would make this package
   * depend on that extension.
   */
  skillDestinationDir(personalityId: string): string | Promise<string>;
  /** Live `SOUL.md` for this personality — `personality.soulFile`. */
  soulFile(personalityId: string): string | Promise<string>;
  /**
   * Recorded for the two queues that carry no personality (`skills/pending/`
   * and flat `skills/.pending/`). The deployment's default personality id.
   */
  defaultPersonalityId: string;
  now?: () => number;
}

export interface LegacyImportResult {
  /** True when the marker was already there and nothing was walked. */
  alreadyImported: boolean;
  candidateIds: string[];
  /** Imported count per source, for the caller's log line. */
  sources: {
    skillsPending: number;
    skillsDotPendingFlat: number;
    skillsDotPendingPerPersonality: number;
    pendingExpression: number;
  };
}

export async function hasImportedLegacy(storage: Storage, dataDir: string): Promise<boolean> {
  return storage.exists(legacyImportMarkerPath(dataDir));
}

export async function importLegacyQueues(deps: LegacyImportDeps): Promise<LegacyImportResult> {
  const { storage, dataDir } = deps;
  const now = deps.now ?? Date.now;
  const result: LegacyImportResult = {
    alreadyImported: false,
    candidateIds: [],
    sources: {
      skillsPending: 0,
      skillsDotPendingFlat: 0,
      skillsDotPendingPerPersonality: 0,
      pendingExpression: 0,
    },
  };

  if (await hasImportedLegacy(storage, dataDir)) {
    result.alreadyImported = true;
    return result;
  }

  const skillsPendingDir = join(dataDir, 'skills', 'pending');
  const dotPendingDir = join(dataDir, 'skills', '.pending');

  result.sources.skillsPending = await importSkillDir(
    deps,
    now,
    skillsPendingDir,
    deps.defaultPersonalityId,
    result.candidateIds,
  );

  for (const entry of await storage.listEntries(dotPendingDir)) {
    if (entry.isDir) {
      if (!SAFE_ID_RE.test(entry.name)) continue;
      result.sources.skillsDotPendingPerPersonality += await importSkillDir(
        deps,
        now,
        join(dotPendingDir, entry.name),
        entry.name,
        result.candidateIds,
      );
    }
  }
  result.sources.skillsDotPendingFlat = await importSkillDir(
    deps,
    now,
    dotPendingDir,
    deps.defaultPersonalityId,
    result.candidateIds,
  );

  result.sources.pendingExpression = await importPendingExpressions(deps, now, result.candidateIds);

  await storage.mkdir(learningDir(dataDir));
  await storage.writeAtomic(
    legacyImportMarkerPath(dataDir),
    `${JSON.stringify({ at: new Date(now()).toISOString(), ...result }, null, 2)}\n`,
  );
  return result;
}

/** `<name>.md`, no separators, no `..` — it becomes a path segment. */
function safeSkillFilename(name: string): boolean {
  return (
    name.endsWith('.md') && !name.includes('/') && !name.includes('\\') && !name.includes('..')
  );
}

/**
 * `target_file:` out of the generated frontmatter, or null.
 *
 * A deliberately narrow reader: only the first `---` block, only that key. The
 * package parses no other YAML, and a full parser here would be a second
 * frontmatter dialect next to `checkSkillFrontmatter`'s.
 */
export function readTargetFile(markdown: string): string | null {
  if (!markdown.startsWith('---')) return null;
  const end = markdown.indexOf('\n---', 3);
  const head = end === -1 ? markdown : markdown.slice(0, end);
  for (const line of head.split('\n')) {
    const m = /^\s*target_file:\s*(.+?)\s*$/.exec(line);
    if (m?.[1]) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

/** A stable id per source file, so a re-import cannot double-submit. */
function legacyIdFor(path: string): string {
  return `l-${sha256Hex(path).slice(0, 16)}`;
}

async function importSkillDir(
  deps: LegacyImportDeps,
  now: () => number,
  dir: string,
  personalityId: string,
  ids: string[],
): Promise<number> {
  const { storage, dataDir } = deps;
  const entries = await storage.listEntries(dir);
  let count = 0;
  for (const entry of entries) {
    if (entry.isDir || !safeSkillFilename(entry.name)) continue;
    const path = join(dir, entry.name);
    const content = await storage.read(path);
    if (content === null) continue;

    const skillDir = await deps.skillDestinationDir(personalityId);
    const target = readTargetFile(content);
    const targetOk = target !== null && TARGET_FILE_RE.test(target);
    const filename = targetOk ? (target.endsWith('.md') ? target : `${target}.md`) : entry.name;

    const candidate = await submitCandidate(
      storage,
      dataDir,
      {
        id: legacyIdFor(path),
        kind: 'skill',
        op: targetOk ? 'rewrite' : 'create',
        personalityId,
        origin: 'legacy',
        destination: join(skillDir, filename),
        content,
        evidence: { ref: path },
        actor: 'legacy-import',
      },
      now,
    );
    await markInvalidTarget(deps, now, candidate, target, targetOk);

    await storage.remove(path);
    ids.push(candidate.id);
    count += 1;
  }
  return count;
}

/**
 * A `target_file` outside the charset does not silently become a new skill: the
 * candidate lands `invalid` and names the value, so a human sees the rewrite
 * that could not be resolved instead of a create nobody asked for.
 */
async function markInvalidTarget(
  deps: LegacyImportDeps,
  now: () => number,
  candidate: LearningCandidate,
  target: string | null,
  targetOk: boolean,
): Promise<void> {
  if (target === null || targetOk) return;
  await updateCandidate(
    deps.storage,
    deps.dataDir,
    candidate.id,
    {
      status: 'invalid',
      actor: 'legacy-import',
      reason: `unusable target_file: ${JSON.stringify(target)}`,
    },
    now,
  );
}

async function importPendingExpressions(
  deps: LegacyImportDeps,
  now: () => number,
  ids: string[],
): Promise<number> {
  const { storage, dataDir } = deps;
  const dir = join(dataDir, 'learning', 'pending-expression');
  let count = 0;
  for (const entry of await storage.listEntries(dir)) {
    if (entry.isDir || !entry.name.endsWith('.json')) continue;
    const path = join(dir, entry.name);
    const raw = await storage.read(path);
    if (raw === null) continue;
    const pending = parsePendingExpression(raw, entry.name.replace(/\.json$/, ''));
    if (!pending) continue;

    const candidate = await submitCandidate(
      storage,
      dataDir,
      {
        id: legacyIdFor(path),
        kind: 'expression',
        op: 'update',
        personalityId: pending.personalityId,
        origin: 'nightly',
        destination: await deps.soulFile(pending.personalityId),
        content: pending.newExpression,
        evidence: { digest: pending.rationale, ref: pending.evidenceRef },
        actor: 'legacy-import',
      },
      now,
    );

    await storage.remove(path);
    ids.push(candidate.id);
    count += 1;
  }
  return count;
}

interface QueuedExpression {
  personalityId: string;
  newExpression: string;
  rationale: string;
  evidenceRef: string;
}

/** Mirrors `readPendingExpression` in `apps/ethos/src/commands/pending-expression.ts`. */
function parsePendingExpression(raw: string, fallbackId: string): QueuedExpression | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof rec[k] === 'string' ? (rec[k] as string) : null;
  const newExpression = str('newExpression');
  if (newExpression === null) return null;
  const personalityId = str('personalityId') ?? fallbackId;
  if (!SAFE_ID_RE.test(personalityId)) return null;
  return {
    personalityId,
    newExpression,
    rationale: str('rationale') ?? '',
    evidenceRef: str('evidenceRef') ?? '',
  };
}
