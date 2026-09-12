// The one candidate store for every learned change (plan `trust-before-reach.md`
// Part 4, L-T1).
//
// Before this there were four queues — `skills/pending/`, flat
// `skills/.pending/`, `skills/.pending/<pid>/` and B-T1's
// `learning/pending-expression/` — each read by a different surface, so the web
// Skills tab never saw a nightly candidate and `ethos evolve apply` could not
// find one. `submitCandidate` is the single entry point that replaces all four;
// rerouting the existing writers onto it is L-T6.
//
// Files through `Storage`, not SQLite (L-D10): a handful of candidates a night,
// human-inspectable on disk, no `synchronous` posture to choose and no roster
// entry in CLAUDE.md's durability table. The cost, also L-D10: a status change
// is check-then-write and not atomic across processes. Every transition lands
// in `audit.jsonl` so a double-apply is visible afterwards.

import { createHash } from 'node:crypto';
import type { Storage } from '@ethosagent/types';
import { appendAudit } from './audit';
import {
  candidateDir,
  candidatePath,
  candidatesDir,
  replayRunIdFromFilename,
  replayRunPath,
} from './paths';

/** What the candidate changes. */
export type CandidateKind = 'skill' | 'expression';

/**
 * How it changes it. `create` writes a file that does not exist, `rewrite`
 * replaces a named existing skill (`target_file`), `update` revises a
 * personality's Expression.
 */
export type CandidateOp = 'create' | 'rewrite' | 'update';

/** Which of the seven writer paths produced it. `legacy` is the one-time import. */
export type CandidateOrigin = 'fork' | 'nightly' | 'chat' | 'eval' | 'web' | 'cli' | 'legacy';

/**
 * `pending_replay` → `pending_review` → `promoted` | `rejected` → `rolled_back`.
 * `invalid` is a candidate that can never promote (unparseable frontmatter);
 * `stale` is one whose `baseHash` no longer matches the live file.
 */
export type CandidateStatus =
  | 'pending_replay'
  | 'pending_review'
  | 'promoted'
  | 'rejected'
  | 'rolled_back'
  | 'invalid'
  | 'stale';

/** L-T4 sets this. `incomplete` means the replay could not be scored, not that it failed. */
export type CandidateVerdict = 'pass' | 'regress' | 'incomplete';

/** Where the candidate came from, for the reviewer and for L-T2's target cases. */
export interface CandidateEvidence {
  /** Session ids the draft was built from. */
  sessionIds: string[];
  /** Kanban task ids, for an eval- or ticket-driven draft. */
  taskIds: string[];
  /** The human-readable evidence digest / rationale shown above the diff. */
  digest: string | null;
  /** Provenance string, e.g. `nightly:0.62@<window>` or the legacy file it came from. */
  ref: string | null;
}

export interface LearningCandidate {
  id: string;
  kind: CandidateKind;
  op: CandidateOp;
  personalityId: string;
  origin: CandidateOrigin;
  /**
   * The live path the content would land on, resolved BY THE CALLER at submit
   * time — `liveSkillDir(dataDir, personalityId, skill_evolution.scope)` plus
   * the filename for a skill, `target_file` for a rewrite, `soulFile` for an
   * Expression. It is an input rather than something this package derives so
   * the package depends on `@ethosagent/types` alone; `liveSkillDir`
   * (`@ethosagent/skill-evolver`) stays the one owner of the scope mapping.
   */
  destination: string;
  content: string;
  /**
   * sha256 of the live bytes AT `destination` when the candidate was
   * submitted, or `null` when nothing was there (a create). L-T5 refuses to
   * promote when it no longer matches, so a human edit made while the
   * candidate waited is never silently clobbered.
   *
   * For an Expression this is the hash of the whole SOUL.md, not of the
   * Expression region — `evolveExpression` runs its own region check on top.
   */
  baseHash: string | null;
  evidence: CandidateEvidence;
  /** Frozen cases (L-T2) the replay must improve on. Set at submit or by L-T4. */
  targetCaseIds: string[];
  status: CandidateStatus;
  verdict: CandidateVerdict | null;
  /** ISO 8601. */
  submittedAt: string;
  updatedAt: string;
}

/** sha256, lowercase hex. Exported because the replay and promote paths hash the same bytes. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Sortable, lowercase, `assertSafeId`-clean. */
export function newCandidateId(now: () => number = Date.now): string {
  const stamp = now().toString(36);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `c-${stamp}-${suffix}`;
}

export interface SubmitCandidateInput {
  kind: CandidateKind;
  op: CandidateOp;
  personalityId: string;
  origin: CandidateOrigin;
  destination: string;
  content: string;
  evidence?: Partial<CandidateEvidence>;
  targetCaseIds?: readonly string[];
  /**
   * Force the candidate id. The legacy import derives one from the source
   * path so a re-import cannot produce a second candidate for the same file;
   * ordinary writers leave it unset.
   */
  id?: string;
  /** Recorded on the audit line. Defaults to the origin. */
  actor?: string;
}

/**
 * The one way a candidate enters the inbox.
 *
 * Reads `destination` to fingerprint the live bytes, writes
 * `candidates/<id>/candidate.json` atomically, and appends one audit line.
 * Re-submitting an existing id is a no-op that returns the stored candidate —
 * that is what makes the legacy import idempotent even with its marker removed.
 */
export async function submitCandidate(
  storage: Storage,
  dataDir: string,
  input: SubmitCandidateInput,
  now: () => number = Date.now,
): Promise<LearningCandidate> {
  const id = input.id ?? newCandidateId(now);
  const existing = await readCandidate(storage, dataDir, id);
  if (existing) return existing;

  const live = await storage.read(input.destination);
  const at = new Date(now()).toISOString();
  const candidate: LearningCandidate = {
    id,
    kind: input.kind,
    op: input.op,
    personalityId: input.personalityId,
    origin: input.origin,
    destination: input.destination,
    content: input.content,
    baseHash: live === null ? null : sha256Hex(live),
    evidence: {
      sessionIds: input.evidence?.sessionIds ?? [],
      taskIds: input.evidence?.taskIds ?? [],
      digest: input.evidence?.digest ?? null,
      ref: input.evidence?.ref ?? null,
    },
    targetCaseIds: [...(input.targetCaseIds ?? [])],
    status: 'pending_replay',
    verdict: null,
    submittedAt: at,
    updatedAt: at,
  };

  await storage.mkdir(candidateDir(dataDir, id));
  await storage.writeAtomic(candidatePath(dataDir, id), `${JSON.stringify(candidate, null, 2)}\n`);
  await appendAudit(
    storage,
    dataDir,
    {
      candidateId: id,
      action: input.origin === 'legacy' ? 'imported' : 'submitted',
      to: candidate.status,
      actor: input.actor ?? input.origin,
      reason: candidate.evidence.ref ?? undefined,
    },
    now,
  );
  return candidate;
}

/** Null for a missing or unparseable record — a broken file must not stop a listing. */
export async function readCandidate(
  storage: Storage,
  dataDir: string,
  candidateId: string,
): Promise<LearningCandidate | null> {
  const raw = await storage.read(candidatePath(dataDir, candidateId));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const c = parsed as LearningCandidate;
  if (typeof c.id !== 'string' || typeof c.destination !== 'string') return null;
  return c;
}

export interface CandidateFilter {
  personalityId?: string;
  kind?: CandidateKind;
  status?: CandidateStatus | readonly CandidateStatus[];
}

/** Every readable candidate, newest first. */
export async function listCandidates(
  storage: Storage,
  dataDir: string,
  filter?: CandidateFilter,
): Promise<LearningCandidate[]> {
  const entries = await storage.listEntries(candidatesDir(dataDir));
  const out: LearningCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    const candidate = await readCandidate(storage, dataDir, entry.name);
    if (!candidate) continue;
    if (filter?.personalityId && candidate.personalityId !== filter.personalityId) continue;
    if (filter?.kind && candidate.kind !== filter.kind) continue;
    if (filter?.status) {
      const wanted = typeof filter.status === 'string' ? [filter.status] : filter.status;
      if (!wanted.includes(candidate.status)) continue;
    }
    out.push(candidate);
  }
  return out.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

export interface CandidateChange {
  status?: CandidateStatus;
  verdict?: CandidateVerdict | null;
  targetCaseIds?: readonly string[];
  /** Who acted: `'nightly'`, `'cli'`, `'web'`, … Recorded on the audit line. */
  actor?: string;
  /** Free text for the audit line — an override reason, a refusal cause. */
  reason?: string;
}

/**
 * Apply a change and record the transition. Throws when the candidate is gone:
 * a status write that silently invents a record would hide the very race
 * L-D10 accepts.
 */
export async function updateCandidate(
  storage: Storage,
  dataDir: string,
  candidateId: string,
  change: CandidateChange,
  now: () => number = Date.now,
): Promise<LearningCandidate> {
  const current = await readCandidate(storage, dataDir, candidateId);
  if (!current) throw new Error(`No such learning candidate: ${candidateId}`);

  const next: LearningCandidate = {
    ...current,
    status: change.status ?? current.status,
    verdict: change.verdict === undefined ? current.verdict : change.verdict,
    targetCaseIds: change.targetCaseIds ? [...change.targetCaseIds] : current.targetCaseIds,
    updatedAt: new Date(now()).toISOString(),
  };
  await storage.writeAtomic(
    candidatePath(dataDir, candidateId),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  await appendAudit(
    storage,
    dataDir,
    {
      candidateId,
      action: 'status',
      from: current.status,
      to: next.status,
      verdict: next.verdict,
      actor: change.actor,
      reason: change.reason,
    },
    now,
  );
  return next;
}

/**
 * Park a replay scorecard beside its candidate. The report shape belongs to
 * L-T4, so it is written verbatim and read back as `unknown`.
 */
export async function writeReplayRun(
  storage: Storage,
  dataDir: string,
  candidateId: string,
  runId: string,
  report: unknown,
  now: () => number = Date.now,
): Promise<void> {
  await storage.mkdir(candidateDir(dataDir, candidateId));
  await storage.writeAtomic(
    replayRunPath(dataDir, candidateId, runId),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await appendAudit(storage, dataDir, { candidateId, action: 'replay', reason: runId }, now);
}

export async function readReplayRun(
  storage: Storage,
  dataDir: string,
  candidateId: string,
  runId: string,
): Promise<unknown | null> {
  const raw = await storage.read(replayRunPath(dataDir, candidateId, runId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Run ids present for a candidate, oldest first by filename. */
export async function listReplayRunIds(
  storage: Storage,
  dataDir: string,
  candidateId: string,
): Promise<string[]> {
  const names = await storage.list(candidateDir(dataDir, candidateId));
  const ids: string[] = [];
  for (const name of names) {
    const runId = replayRunIdFromFilename(name);
    if (runId) ids.push(runId);
  }
  return ids.sort();
}
