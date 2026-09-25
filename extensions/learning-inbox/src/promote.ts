// Promote a learning candidate to its live destination, and roll it back
// (plan `trust-before-reach.md` Part 4, L-T5; design §7).
//
// Before this there were seven promote paths and frontmatter was checked on two
// of them (`runEvolveApply`, `SkillsLibrary.approvePending`). Every approver also
// promoted a rewrite as a NEW `rewrite-<x>-<ts>.md` beside the original, so a
// rewrite was never applied as a rewrite, and skills had no history at all.
// `promote()` is the one path that replaces them (rerouting the callers is L-T6).
//
// What each call guarantees, and where it is enforced:
//
//   Skills
//   - Invalid frontmatter is refused and the candidate becomes `invalid`, before
//     anything is written (`promoteSkill`, via the injected
//     `checkSkillFrontmatter`). A bad file in the live dir is a boot failure.
//   - EVO-001: the model authors the whole file, frontmatter included, so the
//     injected `vetSkill` (`vetPromotedSkill`, extensions/skills/src/promotion-vet.ts)
//     strips the model-owned grant key `ethos.permissions.mcp_env_passthrough`
//     and runs the install scanner (`scanSkillMd` + `canInstall`, `community`
//     tier) on the stripped bytes. A refusal makes the candidate `invalid` and
//     writes nothing. What is written, hashed and rolled back is the STRIPPED
//     content, not `candidate.content`. Pinned by the 'EVO-001' cases in
//     `__tests__/promote.test.ts`.
//   - The destination is re-resolved with the injected `liveSkillDir` and the
//     personality's CURRENT `skill_evolution.scope`; a rewrite's filename comes
//     from the content's `target_file` (`skillFilename`). When that is not the
//     path the candidate was submitted against, its `baseHash` describes a
//     different file, so the candidate becomes `stale`.
//   - The live bytes must still hash to `baseHash`, or the candidate becomes
//     `stale` — someone changed the file after the draft was made against it.
//   - The replaced bytes are snapshotted to `candidates/<id>/prior.md` (or the
//     record says `absent`) and `promotion.json` is written BEFORE the live
//     write, so a promotion that crashed after touching the live file can still
//     be rolled back, and a retry recognises its own bytes (`promoteSkill`'s
//     `alreadyApplied`) instead of calling them stale.
//   - The live write is `Storage.writeAtomic`.
//   - Rollback restores `prior.md` or removes a created file, and refuses when
//     the live file no longer hashes to the promoted bytes (`checkRollback`), so
//     a later human edit is never clobbered.
//
//   Expression
//   - Promotion goes through `evolveExpression`; the revision it returns is kept
//     in `promotion.json`. Rollback calls `revertExpression(prevExpressionRef)`
//     and is allowed only for the personality's most recent promoted Expression
//     candidate (`latestPromotedExpression`) — reverting an older one would
//     silently discard every promotion after it.
//
// Every successful promote and rollback, and every refusal that changes a
// candidate's status (`invalid`, `stale`), goes through `updateCandidate`, which
// appends the transition to `audit.jsonl`. The human-decision rows
// (`recordSafetyApproval`) are L-T8's.
//
// LIMITATIONS — named, not implied away:
//   - L-D10: status changes are check-then-write, not atomic across processes.
//     A human approval and a nightly auto-promotion landing in the same instant
//     can both read `pending_review` and both apply. Both transitions still
//     appear in `audit.jsonl`, and rollback stays available.
//   - Expression rollback detects later promotions made THROUGH this inbox
//     only. An Expression change made outside it (`ethos personality revert`,
//     a hand edit of the Expression region) is not visible here, and a rollback
//     after one reverts over it.
//   - An Expression promotion that crashes between `evolveExpression` and
//     writing `promotion.json` leaves SOUL.md changed with no rollback record;
//     the revision is still in the Learning Log and `.expression-history/`, and
//     a retry sees the new bytes and marks the candidate `stale`.
//
// `liveSkillDir`, the scope lookup, `checkSkillFrontmatter`, `vetSkill` and the Expression
// registry are injected rather than imported. This package sits below
// `@ethosagent/skill-evolver`, `@ethosagent/skills` and
// `@ethosagent/personalities` (see `index.ts`), and L-T6/L-T8 make those call
// into it — importing them here would be a cycle.

import { basename, join } from 'node:path';
import type { LearningLogEntry, Storage } from '@ethosagent/types';
import { readTargetFile } from './import-legacy';
import { candidateDir } from './paths';
import {
  type LearningCandidate,
  listCandidates,
  readCandidate,
  sha256Hex,
  updateCandidate,
} from './store';

/** `skill_evolution.scope` on `PersonalityConfig`. */
export type SkillScope = 'personality' | 'shared';

/** The two `FilePersonalityRegistry` methods promotion uses. */
export interface ExpressionRevisions {
  evolveExpression(
    personalityId: string,
    newExpression: string,
    opts: { summary: string; evidenceRef: string },
  ): Promise<{ entry: LearningLogEntry }>;
  revertExpression(personalityId: string, revisionId: string): Promise<unknown>;
}

export interface PromoteDeps {
  storage: Storage;
  /** `~/.ethos` (or `ETHOS_STATE_DIR`). */
  dataDir: string;
  /** `liveSkillDir` from `@ethosagent/skill-evolver` — pass that function, do not re-derive it. */
  liveSkillDir(dataDir: string, personalityId: string, scope: SkillScope | undefined): string;
  /** The personality's current `skill_evolution.scope`. */
  skillScope(personalityId: string): SkillScope | undefined | Promise<SkillScope | undefined>;
  /** `checkSkillFrontmatter` from `@ethosagent/skills`. */
  checkSkillFrontmatter(markdown: string): { ok: true } | { ok: false; error: string };
  /**
   * `vetPromotedSkill` from `@ethosagent/skills`: the bytes to write (model-owned
   * grant keys removed) or the install scanner's refusal. Runs after
   * `checkSkillFrontmatter`. `candidate` names what is being vetted, for the
   * `install.scan` audit row the wiring binding records.
   */
  vetSkill(
    markdown: string,
    candidate?: { candidateId: string; personalityId: string },
  ): { ok: true; content: string } | { ok: false; error: string };
  /** The `FilePersonalityRegistry`. */
  expressions: ExpressionRevisions;
  now?: () => number;
}

export interface PromoteOptions {
  /** Recorded on the audit line: `'nightly'`, `'cli'`, `'web'`, … */
  actor?: string;
  /** Appended to the audit line's reason — an override reason, for example. */
  reason?: string;
}

/** What a promotion replaced, kept beside the candidate as `promotion.json`. */
export type PromotionRecord =
  | {
      kind: 'skill';
      destination: string;
      /** `snapshot` → the replaced bytes are in `prior.md`; `absent` → it was a create. */
      prior: 'snapshot' | 'absent';
      /** sha256 of the bytes promotion wrote. Rollback refuses when the live file differs. */
      promotedHash: string;
      promotedAt: string;
    }
  | {
      kind: 'expression';
      destination: string;
      /** The revision `evolveExpression` returned. */
      revisionId: string;
      /** The snapshot rollback reverts to. */
      prevExpressionRef: string;
      promotedAt: string;
    };

export type PromoteRefusal = 'not_found' | 'not_promotable' | 'invalid' | 'stale';

export type PromoteResult =
  | { ok: true; candidate: LearningCandidate; record: PromotionRecord }
  | {
      ok: false;
      code: PromoteRefusal;
      reason: string;
      candidate: LearningCandidate | null;
    };

export type RollbackRefusal =
  | 'not_found'
  | 'not_promoted'
  | 'no_record'
  | 'live_edited'
  | 'not_latest';

export type RollbackCheck =
  | { ok: true; candidate: LearningCandidate; record: PromotionRecord }
  | {
      ok: false;
      code: RollbackRefusal;
      reason: string;
      candidate: LearningCandidate | null;
    };

export type RollbackResult =
  | { ok: true; candidate: LearningCandidate }
  | {
      ok: false;
      code: RollbackRefusal;
      reason: string;
      candidate: LearningCandidate | null;
    };

/** Statuses a candidate can be promoted from. Whether a non-`pass` verdict needs an override is L-T8's. */
const PROMOTABLE = new Set<LearningCandidate['status']>(['pending_replay', 'pending_review']);

/**
 * Same charset `createSkillProposeTool` enforces when it writes `target_file`,
 * and `import-legacy.ts` `TARGET_FILE_RE` applies on import. The value becomes
 * a path segment, so it is checked again here.
 */
const TARGET_FILE_RE = /^[a-zA-Z0-9_-]+(\.md)?$/;

export function priorSnapshotPath(dataDir: string, candidateId: string): string {
  return join(candidateDir(dataDir, candidateId), 'prior.md');
}

export function promotionRecordPath(dataDir: string, candidateId: string): string {
  return join(candidateDir(dataDir, candidateId), 'promotion.json');
}

export async function readPromotionRecord(
  storage: Storage,
  dataDir: string,
  candidateId: string,
): Promise<PromotionRecord | null> {
  const raw = await storage.read(promotionRecordPath(dataDir, candidateId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PromotionRecord;
    if (parsed.kind !== 'skill' && parsed.kind !== 'expression') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Apply a candidate to its live destination. Refusals are returned, not thrown. */
export async function promote(
  deps: PromoteDeps,
  candidateId: string,
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  const candidate = await readCandidate(deps.storage, deps.dataDir, candidateId);
  if (!candidate) {
    return { ok: false, code: 'not_found', reason: `No such candidate: ${candidateId}`, candidate };
  }
  if (!PROMOTABLE.has(candidate.status)) {
    return {
      ok: false,
      code: 'not_promotable',
      reason: `Candidate is ${candidate.status}; only pending_replay or pending_review can be promoted`,
      candidate,
    };
  }
  return candidate.kind === 'skill'
    ? promoteSkill(deps, candidate, opts)
    : promoteExpression(deps, candidate, opts);
}

async function promoteSkill(
  deps: PromoteDeps,
  candidate: LearningCandidate,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const { storage, dataDir } = deps;
  const now = deps.now ?? Date.now;

  const frontmatter = deps.checkSkillFrontmatter(candidate.content);
  if (!frontmatter.ok) {
    return refuse(deps, candidate, 'invalid', `invalid frontmatter: ${frontmatter.error}`, opts);
  }
  const vetted = deps.vetSkill(candidate.content, {
    candidateId: candidate.id,
    personalityId: candidate.personalityId,
  });
  if (!vetted.ok) return refuse(deps, candidate, 'invalid', vetted.error, opts);
  const content = vetted.content;

  const filename = skillFilename(candidate);
  if (!filename.ok) return refuse(deps, candidate, 'invalid', filename.reason, opts);

  const scope = await deps.skillScope(candidate.personalityId);
  const dir = deps.liveSkillDir(dataDir, candidate.personalityId, scope);
  const destination = join(dir, filename.name);
  if (destination !== candidate.destination) {
    return refuse(
      deps,
      candidate,
      'stale',
      `destination moved: submitted for ${candidate.destination}, now resolves to ${destination}`,
      opts,
    );
  }

  const promotedHash = sha256Hex(content);
  const live = await storage.read(destination);
  const liveHash = live === null ? null : sha256Hex(live);
  const existing = await readPromotionRecord(storage, dataDir, candidate.id);
  const alreadyApplied =
    existing?.kind === 'skill' &&
    existing.destination === destination &&
    liveHash === existing.promotedHash;

  let record: PromotionRecord;
  if (alreadyApplied) {
    record = existing;
  } else {
    if (liveHash !== candidate.baseHash) {
      return refuse(
        deps,
        candidate,
        'stale',
        `live file changed since submit: ${destination}`,
        opts,
      );
    }
    if (candidate.op === 'rewrite' && live === null) {
      return refuse(
        deps,
        candidate,
        'invalid',
        `rewrite target does not exist: ${destination}`,
        opts,
      );
    }

    await storage.mkdir(candidateDir(dataDir, candidate.id));
    if (live !== null) {
      await storage.writeAtomic(priorSnapshotPath(dataDir, candidate.id), live);
    }
    record = {
      kind: 'skill',
      destination,
      prior: live === null ? 'absent' : 'snapshot',
      promotedHash,
      promotedAt: new Date(now()).toISOString(),
    };
    await writeRecord(storage, dataDir, candidate.id, record);

    await storage.mkdir(dir);
    await storage.writeAtomic(destination, content);
  }

  const updated = await updateCandidate(
    storage,
    dataDir,
    candidate.id,
    {
      status: 'promoted',
      actor: opts.actor,
      reason: withReason(`promoted to ${destination}`, opts.reason),
    },
    now,
  );
  return { ok: true, candidate: updated, record };
}

async function promoteExpression(
  deps: PromoteDeps,
  candidate: LearningCandidate,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const { storage, dataDir } = deps;
  const now = deps.now ?? Date.now;

  if (candidate.op !== 'update') {
    return refuse(
      deps,
      candidate,
      'invalid',
      `an Expression candidate cannot ${candidate.op}`,
      opts,
    );
  }
  const live = await storage.read(candidate.destination);
  const liveHash = live === null ? null : sha256Hex(live);
  if (liveHash !== candidate.baseHash) {
    return refuse(
      deps,
      candidate,
      'stale',
      `SOUL.md changed since submit: ${candidate.destination}`,
      opts,
    );
  }

  // A fixed summary: the Learning Log line quotes it raw on one line, and a
  // digest carries newlines and quotes. `evidenceRef` links back to the candidate.
  const { entry } = await deps.expressions.evolveExpression(
    candidate.personalityId,
    candidate.content,
    { summary: `learning candidate ${candidate.id}`, evidenceRef: `learning:${candidate.id}` },
  );
  const record: PromotionRecord = {
    kind: 'expression',
    destination: candidate.destination,
    revisionId: entry.revisionId,
    prevExpressionRef: entry.prevExpressionRef,
    promotedAt: new Date(now()).toISOString(),
  };
  await storage.mkdir(candidateDir(dataDir, candidate.id));
  await writeRecord(storage, dataDir, candidate.id, record);

  const updated = await updateCandidate(
    storage,
    dataDir,
    candidate.id,
    {
      status: 'promoted',
      actor: opts.actor,
      reason: withReason(`promoted as ${entry.revisionId}`, opts.reason),
    },
    now,
  );
  return { ok: true, candidate: updated, record };
}

/**
 * Whether `rollback` would proceed, without changing anything. The inbox uses
 * it to disable Rollback with an explanation (L-T9).
 */
export async function checkRollback(
  deps: PromoteDeps,
  candidateId: string,
): Promise<RollbackCheck> {
  const { storage, dataDir } = deps;
  const candidate = await readCandidate(storage, dataDir, candidateId);
  if (!candidate) {
    return { ok: false, code: 'not_found', reason: `No such candidate: ${candidateId}`, candidate };
  }
  if (candidate.status !== 'promoted') {
    return {
      ok: false,
      code: 'not_promoted',
      reason: `Candidate is ${candidate.status}; only a promoted candidate can be rolled back`,
      candidate,
    };
  }
  const record = await readPromotionRecord(storage, dataDir, candidateId);
  if (!record) {
    return {
      ok: false,
      code: 'no_record',
      reason: 'No promotion record for this candidate',
      candidate,
    };
  }

  if (record.kind === 'skill') {
    const live = await storage.read(record.destination);
    if (live === null || sha256Hex(live) !== record.promotedHash) {
      return {
        ok: false,
        code: 'live_edited',
        reason: `${record.destination} has changed since it was promoted; rolling back would discard that edit`,
        candidate,
      };
    }
    if (
      record.prior === 'snapshot' &&
      !(await storage.exists(priorSnapshotPath(dataDir, candidateId)))
    ) {
      return {
        ok: false,
        code: 'no_record',
        reason: 'The prior.md snapshot is missing',
        candidate,
      };
    }
    return { ok: true, candidate, record };
  }

  const latest = await latestPromotedExpression(storage, dataDir, candidate.personalityId);
  if (latest !== candidateId) {
    return {
      ok: false,
      code: 'not_latest',
      reason: `A later Expression candidate (${latest ?? 'unknown'}) is promoted for ${candidate.personalityId}; roll that back first`,
      candidate,
    };
  }
  return { ok: true, candidate, record };
}

/** Undo a promotion. Refusals are returned, not thrown; a refusal changes nothing. */
export async function rollback(
  deps: PromoteDeps,
  candidateId: string,
  opts: PromoteOptions = {},
): Promise<RollbackResult> {
  const { storage, dataDir } = deps;
  const check = await checkRollback(deps, candidateId);
  if (!check.ok) return check;
  const { record } = check;

  let summary: string;
  if (record.kind === 'skill') {
    if (record.prior === 'snapshot') {
      const prior = await storage.read(priorSnapshotPath(dataDir, candidateId));
      if (prior === null) {
        return {
          ok: false,
          code: 'no_record',
          reason: 'The prior.md snapshot is missing',
          candidate: check.candidate,
        };
      }
      await storage.writeAtomic(record.destination, prior);
      summary = `restored prior bytes of ${record.destination}`;
    } else {
      await storage.remove(record.destination);
      summary = `removed created ${record.destination}`;
    }
  } else {
    await deps.expressions.revertExpression(
      check.candidate.personalityId,
      record.prevExpressionRef,
    );
    summary = `reverted Expression to ${record.prevExpressionRef}`;
  }

  const candidate = await updateCandidate(
    storage,
    dataDir,
    candidateId,
    { status: 'rolled_back', actor: opts.actor, reason: withReason(summary, opts.reason) },
    deps.now ?? Date.now,
  );
  return { ok: true, candidate };
}

/**
 * The promoted Expression candidate whose revision is newest for this
 * personality. Revision numbers (`expr-rev-<n>`) grow with the Learning Log,
 * so they order promotions without trusting the clock.
 */
async function latestPromotedExpression(
  storage: Storage,
  dataDir: string,
  personalityId: string,
): Promise<string | null> {
  const promoted = await listCandidates(storage, dataDir, {
    personalityId,
    kind: 'expression',
    status: 'promoted',
  });
  let best: { id: string; rev: number; at: string } | null = null;
  for (const c of promoted) {
    const record = await readPromotionRecord(storage, dataDir, c.id);
    if (record?.kind !== 'expression') continue;
    const rev = revisionNumber(record.revisionId);
    if (!best || rev > best.rev || (rev === best.rev && record.promotedAt > best.at)) {
      best = { id: c.id, rev, at: record.promotedAt };
    }
  }
  return best?.id ?? null;
}

function revisionNumber(revisionId: string): number {
  const m = /(\d+)$/.exec(revisionId);
  return m?.[1] ? Number(m[1]) : -1;
}

/** `create` keeps the submitted filename; `rewrite` writes the content's `target_file`. */
function skillFilename(
  candidate: LearningCandidate,
): { ok: true; name: string } | { ok: false; reason: string } {
  if (candidate.op === 'create') return { ok: true, name: basename(candidate.destination) };
  if (candidate.op === 'rewrite') {
    const target = readTargetFile(candidate.content);
    if (target === null) return { ok: false, reason: 'rewrite has no target_file' };
    if (!TARGET_FILE_RE.test(target)) {
      return { ok: false, reason: `unusable target_file: ${JSON.stringify(target)}` };
    }
    return { ok: true, name: target.endsWith('.md') ? target : `${target}.md` };
  }
  return { ok: false, reason: `a skill candidate cannot ${candidate.op}` };
}

async function refuse(
  deps: PromoteDeps,
  candidate: LearningCandidate,
  code: 'invalid' | 'stale',
  reason: string,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const updated = await updateCandidate(
    deps.storage,
    deps.dataDir,
    candidate.id,
    { status: code, actor: opts.actor, reason },
    deps.now ?? Date.now,
  );
  return { ok: false, code, reason, candidate: updated };
}

async function writeRecord(
  storage: Storage,
  dataDir: string,
  candidateId: string,
  record: PromotionRecord,
): Promise<void> {
  await storage.writeAtomic(
    promotionRecordPath(dataDir, candidateId),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function withReason(summary: string, reason: string | undefined): string {
  return reason ? `${summary} — ${reason}` : summary;
}
