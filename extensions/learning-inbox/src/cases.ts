// Frozen replay cases (L-T2).
//
// A case is one past task with its answer criteria, written ONCE to
// `~/.ethos/learning/cases/<pid>/<caseId>.json` and never edited. Frozen
// because replay must not depend on `sessions.db` retention: a candidate
// submitted tonight is replayed against the same prompts next month, after the
// sessions it came from have been pruned.
//
// The readers for the three sources are injected. This package depends on
// `@ethosagent/types` (plus `@ethosagent/safety-groundtruth` for the one
// `check:` predicate), so the kanban store, the eval harness and the session
// store reach it as functions, not as imports.

import { createHash } from 'node:crypto';
import { isCheckLine } from '@ethosagent/safety-groundtruth';
import type { Storage } from '@ethosagent/types';
import { casePath, casesDir } from './paths';
import { type CandidateStatus, listCandidates } from './store';

/**
 * Session keys that NEVER feed learning (X-D7). One list, imported by case
 * capture here and by L-D12's evidence filter in the nightly drafters, because
 * two copies would disagree and the disagreement is a contaminated case pool.
 *
 * Every entry is a session Ethos itself drove, not a person talking to it:
 *
 *  - `eval:`             `EvalRunner` tasks, including the Judge's own replays
 *  - `replay:`           this part's replay arms (`replay:<cid>:<arm>:<caseId>`)
 *  - `improvement-fork-` the post-turn fork's isolated turn
 *  - `nightly`           the nightly pass's own turns
 *  - `cron:`             scheduled job turns — a machine's prompt, on a timer
 *  - `mcp:`              an external MCP client's text (M-D6: persistent injection)
 *  - `mcp-console:`      the MCP console's turns, same rationale
 *  - `outbox-review:`    Part 2's advisory reviewer turns
 *  - `pack-check:`       Part 5's pack scenario runs
 */
export const LEARNING_EXCLUDED_KEY_PREFIXES: readonly string[] = [
  'eval:',
  'replay:',
  'improvement-fork-',
  'nightly',
  'cron:',
  'mcp:',
  'mcp-console:',
  'outbox-review:',
  'pack-check:',
];

export function isExcludedSessionKey(sessionKey: string): boolean {
  return LEARNING_EXCLUDED_KEY_PREFIXES.some((p) => sessionKey.startsWith(p));
}

/** Cases held per personality. Oldest evicted first once the pool is full. */
export const CASE_POOL_CAP = 40;

/** New cases one freeze pass may add per personality. */
export const CASE_FREEZE_BATCH = 10;

/** Preceding plain-text messages kept with a case. */
export const CASE_CONTEXT_MESSAGES = 4;

/**
 * `criteria` is graded by `llmJudgeScorer`; `contains` / `regex` / `exact` by
 * the eval-harness scorers; `tool_called` / `tool_not_called` against the
 * dry-run plan. `exact` exists because an eval task keeps its authored `match`
 * kind and `exact` is one of the four the harness supports — L-T4's scorer
 * table must therefore cover it, or an authored assertion goes ungraded.
 */
export type AssertionKind =
  | 'criteria'
  | 'contains'
  | 'regex'
  | 'exact'
  | 'tool_called'
  | 'tool_not_called';

export interface CaseAssertion {
  kind: AssertionKind;
  /** Prose for `criteria`, the literal / pattern / tool name for the rest. */
  value: string;
}

/** Strongest first: a ticket with acceptance criteria beats a session turn. */
export type CaseSource = 'kanban' | 'eval' | 'session';

export interface LearningCase {
  id: string;
  personalityId: string;
  prompt: string;
  /** Up to `CASE_CONTEXT_MESSAGES` preceding plain-text messages, oldest first. */
  context: string[];
  assertions: CaseAssertion[];
  source: CaseSource;
  /** Where it came from: `kanban:<taskId>`, `eval:<taskId>`, `session:<messageId>`. */
  sourceRef: string;
  /** ISO 8601. The FIFO eviction order. */
  frozenAt: string;
}

/**
 * Derived from the source reference, not from a clock or a counter: a second
 * capture of the same ticket must land on the same path and find the file
 * already there, which is what makes freezing write-once.
 */
export function caseIdFor(source: CaseSource, sourceRef: string): string {
  return createHash('sha256').update(`${source}:${sourceRef}`, 'utf8').digest('hex').slice(0, 16);
}

// --- Source shapes ---------------------------------------------------------
// Structural, not imported: the kanban store, the eval harness and the session
// store all live above this package in the layer model.

export interface KanbanCaseTask {
  id: string;
  title: string;
  body: string;
  /** The `acceptance_criteria` prose, `check:` lines included. */
  acceptanceCriteria: string | null;
}

export interface EvalCaseTask {
  id: string;
  prompt: string;
  /** The authored expected value. */
  expected: string;
  match?: 'exact' | 'contains' | 'regex' | 'llm';
}

export interface SessionCaseTurn {
  /** The session key, checked against `LEARNING_EXCLUDED_KEY_PREFIXES`. */
  sessionKey: string;
  /** Stable id of the user message, so a re-capture is a no-op. */
  messageId: string;
  prompt: string;
  /** Preceding plain-text messages, oldest first. Trimmed to 4. */
  context?: string[];
}

// --- Builders --------------------------------------------------------------

/**
 * A done ticket with acceptance criteria. The prose becomes one `criteria`
 * assertion; `check:` lines are DROPPED — they settle workdir facts (a file
 * exists, a command exits 0) that a dry-run replay cannot produce, so scoring
 * them would fail every candidate for a reason the candidate did not cause.
 * `isCheckLine` is the one owner of that predicate
 * (`packages/safety/groundtruth/src/checks.ts`); a second copy of the rule here
 * could disagree with the kanban verifier's stripper.
 *
 * Returns null when nothing but `check:` lines is left — there is no criterion
 * to judge.
 */
export function caseFromKanbanTask(
  personalityId: string,
  task: KanbanCaseTask,
  frozenAt: string,
): LearningCase | null {
  const criteria = (task.acceptanceCriteria ?? '')
    .split('\n')
    .filter((line) => !isCheckLine(line))
    .join('\n')
    .trim();
  if (!criteria) return null;
  const prompt = [task.title, task.body].filter((s) => s.trim().length > 0).join('\n\n');
  if (!prompt.trim()) return null;
  const sourceRef = `kanban:${task.id}`;
  return {
    id: caseIdFor('kanban', sourceRef),
    personalityId,
    prompt,
    context: [],
    assertions: [{ kind: 'criteria', value: criteria }],
    source: 'kanban',
    sourceRef,
    frozenAt,
  };
}

/** An eval task with an authored expected value, keeping its `match` kind. */
export function caseFromEvalTask(
  personalityId: string,
  task: EvalCaseTask,
  frozenAt: string,
): LearningCase | null {
  if (!task.prompt.trim() || !task.expected.trim()) return null;
  const kind: AssertionKind = task.match === 'llm' || !task.match ? 'criteria' : task.match;
  const sourceRef = `eval:${task.id}`;
  return {
    id: caseIdFor('eval', sourceRef),
    personalityId,
    prompt: task.prompt,
    context: [],
    assertions: [{ kind, value: task.expected }],
    source: 'eval',
    sourceRef,
    frozenAt,
  };
}

/**
 * A real user turn. Two `criteria` assertions, both about the answer rather
 * than its content — nobody authored an expected value for a chat message, and
 * the Core is the only text a replay may hold the answer to.
 *
 * Returns null for an excluded session key: those turns are Ethos talking to
 * itself, and learning from them is a feedback loop, not evidence.
 */
export function caseFromSessionTurn(
  personalityId: string,
  turn: SessionCaseTurn,
  core: string,
  frozenAt: string,
): LearningCase | null {
  if (isExcludedSessionKey(turn.sessionKey)) return null;
  if (!turn.prompt.trim()) return null;
  const sourceRef = `session:${turn.messageId}`;
  return {
    id: caseIdFor('session', sourceRef),
    personalityId,
    prompt: turn.prompt,
    context: (turn.context ?? []).slice(-CASE_CONTEXT_MESSAGES),
    assertions: [
      { kind: 'criteria', value: `stays true to this Core: ${core}` },
      { kind: 'criteria', value: 'directly addresses the request' },
    ],
    source: 'session',
    sourceRef,
    frozenAt,
  };
}

// --- Pool ------------------------------------------------------------------

/**
 * Write a case if it is not already there. `'exists'` means the frozen file was
 * left byte-for-byte alone — a case is evidence of what was asked once, and
 * rewriting it would let a later capture move the goalposts a replay is scored
 * against.
 */
export async function freezeCase(
  storage: Storage,
  dataDir: string,
  learningCase: LearningCase,
): Promise<'frozen' | 'exists'> {
  const path = casePath(dataDir, learningCase.personalityId, learningCase.id);
  if (await storage.exists(path)) return 'exists';
  await storage.mkdir(casesDir(dataDir, learningCase.personalityId));
  await storage.writeAtomic(path, `${JSON.stringify(learningCase, null, 2)}\n`);
  return 'frozen';
}

export async function readCase(
  storage: Storage,
  dataDir: string,
  personalityId: string,
  caseId: string,
): Promise<LearningCase | null> {
  const raw = await storage.read(casePath(dataDir, personalityId, caseId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LearningCase;
    return typeof parsed?.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Every readable case for a personality, oldest first. */
export async function listCases(
  storage: Storage,
  dataDir: string,
  personalityId: string,
): Promise<LearningCase[]> {
  const names = await storage.list(casesDir(dataDir, personalityId));
  const out: LearningCase[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const c = await readCase(storage, dataDir, personalityId, name.slice(0, -'.json'.length));
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.frozenAt.localeCompare(b.frozenAt) || a.id.localeCompare(b.id));
}

/**
 * Candidate statuses whose target cases the pool cap never evicts.
 *
 * Exactly the statuses a candidate can still be replayed or decided from —
 * `replay.ts` `REPLAYABLE`, `inbox.ts` `AWAITING_DECISION`, `promote.ts`
 * `PROMOTABLE` — because those are the only candidates whose targets will be
 * measured again (verdict rules (a) and (c)). Everything else is terminal FOR
 * ITS EVIDENCE: `promoted` and `rejected` were decided; `rolled_back` restores
 * bytes without replaying; `invalid` and `stale` can be rejected but never
 * replayed or promoted. Their targets are ordinary pool cases, oldest first.
 */
export const CASE_PINNING_STATUSES: readonly CandidateStatus[] = [
  'pending_replay',
  'pending_review',
];

/**
 * Every case id that is a target of a non-terminal candidate of this
 * personality (`CASE_PINNING_STATUSES`). Read from the candidate store each
 * time the cap runs, so no capture path has to remember to pass it.
 *
 * LIMITATIONS: a `candidate.json` that does not parse pins nothing
 * (`readCandidate` returns null for it). And like every status check in this
 * package (L-D10) it is check-then-act: a candidate submitted by another
 * process after this read is not seen by the trim already running. Its targets
 * are frozen moments before it is submitted, so they are the NEWEST cases in
 * the pool and FIFO reaches them last.
 */
export async function pinnedCaseIds(
  storage: Storage,
  dataDir: string,
  personalityId: string,
): Promise<Set<string>> {
  const candidates = await listCandidates(storage, dataDir, {
    personalityId,
    status: CASE_PINNING_STATUSES,
  });
  return new Set(candidates.flatMap((c) => c.targetCaseIds));
}

export interface CasePoolTrim {
  /** Case ids removed, oldest first. */
  evicted: string[];
  /** Cases left in the pool that are pinned by a non-terminal candidate. */
  pinned: number;
  /**
   * How far the pool still sits above `cap` after the trim. Non-zero only when
   * pinned cases alone exceed the cap — see `enforceCasePoolCap`.
   */
  overflow: number;
}

/**
 * Trim the pool to `cap`, oldest first, never evicting a case that is a target
 * of a non-terminal candidate (`pinnedCaseIds`). This is the ONE place the cap
 * is enforced — the nightly freeze (`packages/wiring/src/learning-pipeline.ts`
 * `freezeNightlyCases`) and the regression top-up (`replay.ts`
 * `topUpRegressionPool`) both reach it through `captureCases`, so a top-up for
 * one candidate cannot evict another pending candidate's targets. Pinned by
 * `__tests__/cases.test.ts` ("the pool — pinned target cases").
 *
 * OVERFLOW: when pinned cases alone exceed `cap`, every unpinned case is
 * evicted and the pool stays above `cap` by `overflow`. The trade-off is chosen
 * to fail safe: destroying a pending candidate's target would make its replay
 * `incomplete` — or measure it against cases other than the ones it was
 * drafted to fix — with nothing recording why, whereas an oversized pool costs
 * disk bounded by the targets of undecided candidates, and a human deciding
 * them releases it. While it lasts the pool holds only pinned targets and no
 * session or ticket case, and nothing new is frozen (`captureCases`), so the
 * regression top-up cannot add one. A replay still regresses against every
 * pool case except its OWN targets (`replay.ts` `selectReplayCases`), so other
 * undecided candidates' targets count as its regression cases; it fails closed
 * as `incomplete` rather than passing on nothing (rule (a)) only when no such
 * case exists. The `ethos nightly` notice says the same (`nightly-loop`
 * `casePoolOverflowNotice`).
 */
export async function enforceCasePoolCap(
  storage: Storage,
  dataDir: string,
  personalityId: string,
  cap: number = CASE_POOL_CAP,
): Promise<CasePoolTrim> {
  const pinned = await pinnedCaseIds(storage, dataDir, personalityId);
  return trimPool(storage, dataDir, personalityId, cap, pinned);
}

async function trimPool(
  storage: Storage,
  dataDir: string,
  personalityId: string,
  cap: number,
  pinned: ReadonlySet<string>,
): Promise<CasePoolTrim> {
  const cases = await listCases(storage, dataDir, personalityId);
  const pinnedCount = cases.filter((c) => pinned.has(c.id)).length;
  const excess = Math.max(0, cases.length - cap);
  const evicted = cases.filter((c) => !pinned.has(c.id)).slice(0, excess);
  for (const c of evicted) await storage.remove(casePath(dataDir, personalityId, c.id));
  return {
    evicted: evicted.map((c) => c.id),
    pinned: pinnedCount,
    overflow: Math.max(0, cases.length - evicted.length - cap),
  };
}

export interface CaptureCasesOptions {
  storage: Storage;
  dataDir: string;
  personalityId: string;
  /** The personality's Core, for the session-turn assertion. */
  core: string;
  /** Done tickets assigned to this personality, strongest source first. */
  kanbanTasks?: () => Promise<KanbanCaseTask[]>;
  /** Eval tasks with authored expected values. */
  evalTasks?: () => Promise<EvalCaseTask[]>;
  /** Recent user turns. Excluded keys are filtered here, not by the caller. */
  sessionTurns?: () => Promise<SessionCaseTurn[]>;
  /** New cases this pass may freeze. Defaults to `CASE_FREEZE_BATCH`. */
  limit?: number;
  /** Pool size afterwards. Defaults to `CASE_POOL_CAP`. */
  cap?: number;
  now?: () => number;
}

export interface CaptureCasesResult {
  frozen: string[];
  /** Cases already on disk that this pass left untouched. */
  skipped: number;
  evicted: string[];
  /** Cases left in the pool that are pinned by a non-terminal candidate. */
  pinned: number;
  /** How far the pool sits above `cap` afterwards (`CasePoolTrim.overflow`). */
  overflow: number;
}

/**
 * One freeze pass for one personality: at most `limit` new cases, strongest
 * source first, then the pool trimmed back to `cap` without evicting a pinned
 * target (`enforceCasePoolCap`).
 *
 * The pass also freezes no more than the pool has room for once pinned cases
 * are counted: a case frozen past that room would be the newest unpinned case
 * and the same trim would have to evict it — or, with pinned cases already at
 * or over the cap, every new case would be. So an overflowing pool freezes
 * nothing, and `overflow` on the result says why.
 */
export async function captureCases(opts: CaptureCasesOptions): Promise<CaptureCasesResult> {
  const { storage, dataDir, personalityId } = opts;
  const limit = opts.limit ?? CASE_FREEZE_BATCH;
  const frozenAt = new Date((opts.now ?? Date.now)()).toISOString();
  const cap = opts.cap ?? CASE_POOL_CAP;
  const result: CaptureCasesResult = {
    frozen: [],
    skipped: 0,
    evicted: [],
    pinned: 0,
    overflow: 0,
  };
  // Read once for the pass: the room below and the trim after use the same set.
  const pinned = await pinnedCaseIds(storage, dataDir, personalityId);
  const pinnedInPool = (await listCases(storage, dataDir, personalityId)).filter((c) =>
    pinned.has(c.id),
  ).length;
  const room = Math.min(limit, Math.max(0, cap - pinnedInPool));

  const candidates: LearningCase[] = [];
  for (const task of (await opts.kanbanTasks?.()) ?? []) {
    const c = caseFromKanbanTask(personalityId, task, frozenAt);
    if (c) candidates.push(c);
  }
  for (const task of (await opts.evalTasks?.()) ?? []) {
    const c = caseFromEvalTask(personalityId, task, frozenAt);
    if (c) candidates.push(c);
  }
  for (const turn of (await opts.sessionTurns?.()) ?? []) {
    const c = caseFromSessionTurn(personalityId, turn, opts.core, frozenAt);
    if (c) candidates.push(c);
  }

  for (const c of candidates) {
    if (result.frozen.length >= room) break;
    const outcome = await freezeCase(storage, dataDir, c);
    if (outcome === 'frozen') result.frozen.push(c.id);
    else result.skipped += 1;
  }

  const trim = await trimPool(storage, dataDir, personalityId, cap, pinned);
  return { ...result, ...trim };
}
