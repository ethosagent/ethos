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

/** Trim the pool to `cap`, oldest first. Returns the case ids removed. */
export async function enforceCasePoolCap(
  storage: Storage,
  dataDir: string,
  personalityId: string,
  cap: number = CASE_POOL_CAP,
): Promise<string[]> {
  const cases = await listCases(storage, dataDir, personalityId);
  if (cases.length <= cap) return [];
  const evicted = cases.slice(0, cases.length - cap);
  for (const c of evicted) await storage.remove(casePath(dataDir, personalityId, c.id));
  return evicted.map((c) => c.id);
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
}

/**
 * One freeze pass for one personality: at most `limit` new cases, strongest
 * source first, then the pool trimmed back to `cap`.
 */
export async function captureCases(opts: CaptureCasesOptions): Promise<CaptureCasesResult> {
  const { storage, dataDir, personalityId } = opts;
  const limit = opts.limit ?? CASE_FREEZE_BATCH;
  const frozenAt = new Date((opts.now ?? Date.now)()).toISOString();
  const result: CaptureCasesResult = { frozen: [], skipped: 0, evicted: [] };

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
    if (result.frozen.length >= limit) break;
    const outcome = await freezeCase(storage, dataDir, c);
    if (outcome === 'frozen') result.frozen.push(c.id);
    else result.skipped += 1;
  }

  result.evicted = await enforceCasePoolCap(storage, dataDir, personalityId, opts.cap);
  return result;
}
