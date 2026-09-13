// The replay runner and scorer (plan `trust-before-reach.md` Part 4, L-T4,
// Design sections 3 and 4).
//
// A candidate is measured, not judged (L-D1): each selected case runs through a
// BASELINE arm (what is live) and a CANDIDATE arm (the one shadowed path), both
// as dry runs, and each arm is scored on the case's assertions. `verdict.ts`
// turns the scores into `pass` / `regress` / `incomplete`.
//
// What this module does NOT do, and who does (rule 12):
//
//  - Build the arm's loop. Assembling an `AgentLoop` is wiring's job and wiring
//    sits above extensions, so the loop arrives through `createArm` — in
//    production `createReplayLoop` (`packages/wiring/src/learning-replay.ts`),
//    which forces `oneShot`, `disableDocker` and the `replay` isolation.
//  - Decide what a replay turn carries. `runOptions` is wiring's
//    `REPLAY_RUN_OPTIONS`, spread into every turn here. Its type admits only
//    `dryRun: true` and `temperature: 0`, and `runReplay` re-checks `dryRun` at
//    runtime, because a replay that is not a dry run publishes (X-D6).
//  - Promote. Nothing here changes a live file; `replayCandidate` records the
//    scorecard and the verdict and stops.
//
// Every arm's loop is disposed in a `finally`, including when the case throws:
// a leaked loop holds sqlite handles and MCP children.
//
// Limitation (L-D4, printed on every scorecard via `REPLAY_LIMITATIONS`): tools
// are stubbed, so a replay measures tool choice, arguments, voice and approach,
// not answers that depend on real tool output.

import {
  collectDryRunPlan,
  containsScorer,
  exactMatchScorer,
  llmJudgeScorer,
  regexScorer,
  type Scorer,
  toolCalledScorer,
} from '@ethosagent/eval-harness';
import type {
  AgentEvent,
  DryRunToolPlan,
  LLMProvider,
  SessionStore,
  Storage,
} from '@ethosagent/types';
import {
  type AssertionKind,
  type CaptureCasesResult,
  type CaseSource,
  captureCases,
  type LearningCase,
  listCases,
  readCase,
  type SessionCaseTurn,
} from './cases';
import type { OverlayShadow } from './overlay-storage';
import {
  type CandidateStatus,
  type LearningCandidate,
  readCandidate,
  updateCandidate,
  writeReplayRun,
} from './store';
import {
  type CaseRole,
  computeVerdict,
  MAX_REPLAY_CASES,
  MAX_TARGET_CASES,
  MIN_REPLAY_CASES,
  type VerdictResult,
} from './verdict';

export type ReplayArm = 'baseline' | 'candidate';

/** `RunOptions.dryRunMaxToolCalls` for every replay turn (Design section 3). */
export const REPLAY_DRY_RUN_MAX_TOOL_CALLS = 8;

/**
 * Criteria assertions graded per case. The grader's calls are not counted in
 * dollars — `llmJudgeScorer` (`extensions/eval-harness/src/scorers.ts`) reads
 * the verdict text and reports no `usage` — so they are bounded by COUNT
 * instead (L-D7): 3 criteria × 2 arms × `MAX_REPLAY_CASES` (8) = 48 calls per
 * candidate at most. `selectReplayCases` is the enforcer: a case with more
 * criteria than this is skipped, not partly graded.
 */
export const MAX_CRITERIA_PER_CASE = 3;

/** Printed on every scorecard (L-D4). */
export const REPLAY_LIMITATIONS: readonly string[] = [
  'dry-run: tools stubbed — replay measures tool choice, arguments, voice and approach, not answers that depend on real tool output',
  'grader calls are not counted against maxCostUsd; they are bounded by count (at most 48 per candidate)',
];

/**
 * The fields wiring's `REPLAY_RUN_OPTIONS` carries. Literal types: nothing but
 * `{ dryRun: true, temperature: 0 }` is assignable.
 */
export interface ReplayBaseRunOptions {
  readonly dryRun: true;
  readonly temperature: 0;
}

/** Exactly what one replay turn is run with. A subset of core's `RunOptions`. */
export interface ReplayTurnOptions extends ReplayBaseRunOptions {
  dryRunMaxToolCalls: number;
  /** `replay:<candidateId>:<arm>:<caseId>` — X-D7 never learns from `replay:`. */
  sessionKey: string;
  personalityId: string;
  /** Aborted when the run crosses `maxCostUsd` mid-turn. */
  abortSignal: AbortSignal;
}

/** One arm's loop. `CreateAgentLoopResult` satisfies it structurally. */
export interface ReplayArmRuntime {
  loop: { run(prompt: string, options: ReplayTurnOptions): AsyncIterable<AgentEvent> };
  dispose(): Promise<void>;
}

export interface CreateReplayArmInput {
  arm: ReplayArm;
  /** `null` for the baseline arm. */
  shadow: OverlayShadow | null;
  /** The in-memory session the case's context was seeded into. */
  session: SessionStore;
}

export type CreateReplayArm = (input: CreateReplayArmInput) => Promise<ReplayArmRuntime>;

// --- Case selection --------------------------------------------------------

export interface SelectedCase {
  role: CaseRole;
  case: LearningCase;
}

export interface SkippedCase {
  caseId: string;
  reason: string;
}

/**
 * L-D6: at most `maxCases` (never more than 8) cases, at most 3 of them target
 * cases, the rest filled from the regression pool newest first. The minimum of
 * 3 is `computeVerdict`'s rule (a), not a refusal here — a short selection
 * still produces a scorecard that says why it is `incomplete`.
 *
 * One slot is always kept for a regression case: targets are capped at
 * `min(3, maxCases - 1)`. Rule (a) also requires a regression case, so at
 * `maxCases: 3` (the config minimum) three targets would fill every slot and
 * make the run `incomplete` however large the pool is.
 */
export function selectReplayCases(
  targets: readonly LearningCase[],
  pool: readonly LearningCase[],
  maxCases: number,
): { selected: SelectedCase[]; skipped: SkippedCase[] } {
  const limit = Math.max(0, Math.min(Math.floor(maxCases), MAX_REPLAY_CASES));
  const skipped: SkippedCase[] = [];
  const gradable = (c: LearningCase): boolean => {
    const criteria = c.assertions.filter((a) => a.kind === 'criteria').length;
    if (criteria <= MAX_CRITERIA_PER_CASE) return true;
    skipped.push({
      caseId: c.id,
      reason: `${criteria} criteria assertions; at most ${MAX_CRITERIA_PER_CASE} are graded per case`,
    });
    return false;
  };

  const targetCap = Math.max(0, Math.min(MAX_TARGET_CASES, limit - 1));
  const selected: SelectedCase[] = [];
  const seen = new Set<string>();
  for (const c of targets) {
    if (seen.has(c.id) || !gradable(c)) continue;
    seen.add(c.id);
    if (selected.length >= targetCap) {
      skipped.push({
        caseId: c.id,
        reason:
          targetCap === MAX_TARGET_CASES
            ? `more than ${MAX_TARGET_CASES} target cases`
            : `more than ${targetCap} target cases; one of ${limit} slots is kept for a regression case`,
      });
      continue;
    }
    selected.push({ role: 'target', case: c });
  }

  const newestFirst = [...pool].sort(
    (x, y) => y.frozenAt.localeCompare(x.frozenAt) || x.id.localeCompare(y.id),
  );
  for (const c of newestFirst) {
    if (selected.length >= limit) break;
    if (seen.has(c.id) || !gradable(c)) continue;
    seen.add(c.id);
    selected.push({ role: 'regression', case: c });
  }
  return { selected, skipped };
}

/**
 * How many more REGRESSION cases this selection needs before rule (a) can hold:
 * at least one, and enough that targets plus regressions reach
 * `MIN_REPLAY_CASES`. Zero when the selection already has them. Computed on
 * `selectReplayCases`'s own output, so a target the case cap skipped, an
 * ungradable pool case, or a pool case that IS a target never counts as a
 * regression case here either.
 *
 * With no selectable target the answer is still positive: topping up the pool
 * cannot give the candidate a target, and rule (a) keeps it `incomplete`.
 */
export function regressionShortfall(
  targets: readonly LearningCase[],
  pool: readonly LearningCase[],
  maxCases: number,
): number {
  const limit = Math.max(0, Math.min(Math.floor(maxCases), MAX_REPLAY_CASES));
  const { selected } = selectReplayCases(targets, pool, maxCases);
  const targetCount = selected.filter((s) => s.role === 'target').length;
  const regressionCount = selected.length - targetCount;
  const wanted = Math.max(1, MIN_REPLAY_CASES - targetCount);
  // A regression slot the case cap does not leave cannot be filled by freezing.
  const fillable = Math.max(0, limit - targetCount);
  return Math.max(0, Math.min(wanted, fillable) - regressionCount);
}

// --- Report shapes ---------------------------------------------------------

export interface AssertionResult {
  kind: AssertionKind | 'completed';
  value: string;
  passed: boolean;
}

export interface ReplayArmResult {
  arm: ReplayArm;
  /** The turn's final text (`done.text`), or the streamed deltas when no `done` arrived. */
  text: string;
  /** `dry_run_summary.plan`, via `collectDryRunPlan` (X-D12). */
  plan: DryRunToolPlan[];
  errors: { error: string; code: string }[];
  halts: { kind: 'budget' | 'watcher'; rule: string; message: string }[];
  /** Sum of this arm's `usage.estimatedCostUsd`. */
  costUsd: number;
  /** No `error` event and no `halt`. */
  completed: boolean;
  assertions: AssertionResult[];
  /** Assertions passed ÷ total, `completed` included. */
  score: number;
}

export interface ReplayCaseResult {
  caseId: string;
  role: CaseRole;
  source: CaseSource;
  sourceRef: string;
  prompt: string;
  baseline: ReplayArmResult | null;
  candidate: ReplayArmResult | null;
  /** candidate.score − baseline.score, when both ran. */
  delta: number | null;
}

/** Why a run ended before every selected case ran in both arms. */
export type ReplayStopReason = 'budget' | 'error' | 'insufficient_cases';

export interface ReplayReport extends VerdictResult {
  runId: string;
  candidateId: string;
  /** L-D11: the only personality this replay measured. */
  testedOn: string;
  startedAt: string;
  finishedAt: string;
  /** Summed from the replay loops' `usage` events. */
  costUsd: number;
  maxCostUsd: number;
  stopReason: ReplayStopReason | null;
  /** The thrown message when `stopReason` is `error`. */
  error: string | null;
  cases: ReplayCaseResult[];
  skipped: SkippedCase[];
  limitations: readonly string[];
}

// --- Running ---------------------------------------------------------------

export interface RunReplayInput {
  candidateId: string;
  personalityId: string;
  /** The candidate arm's shadow (`shadowForCandidate` in wiring). */
  shadow: OverlayShadow;
  targetCases: readonly LearningCase[];
  /** The personality's case pool; target ids are excluded from it here. */
  regressionPool: readonly LearningCase[];
  createArm: CreateReplayArm;
  /** A fresh, empty in-memory session store per arm. */
  newSession: () => SessionStore;
  /** The default LLM, for `criteria` assertions. */
  grader: LLMProvider;
  /** Wiring's `REPLAY_RUN_OPTIONS`. */
  runOptions: ReplayBaseRunOptions;
  maxCases: number;
  maxCostUsd: number;
  now?: () => number;
}

/** A run id `assertSafeId` accepts. */
export function newReplayRunId(now: () => number = Date.now): string {
  return `r-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

/**
 * Seed a case's preceding messages. `LearningCase.context` records text, not
 * roles, so roles are assigned by alternation counted back from the prompt:
 * the message right before the user's prompt is the assistant's.
 */
async function seedContext(
  session: SessionStore,
  sessionKey: string,
  personalityId: string,
  context: readonly string[],
): Promise<void> {
  if (context.length === 0) return;
  const created = await session.createSession({
    key: sessionKey,
    platform: 'replay',
    model: 'replay',
    provider: 'replay',
    personalityId,
    usage: { ...ZERO_USAGE },
  });
  for (const [i, content] of context.entries()) {
    const fromEnd = context.length - i;
    await session.appendMessage({
      sessionId: created.id,
      role: fromEnd % 2 === 1 ? 'assistant' : 'user',
      content,
    });
  }
}

interface ArmRun {
  events: AgentEvent[];
  costUsd: number;
  overBudget: boolean;
}

/** Score one arm. The grader sees the response and the criterion — never the arm. */
async function scoreArm(
  arm: ReplayArm,
  learningCase: LearningCase,
  run: ArmRun,
  grader: LLMProvider,
): Promise<ReplayArmResult> {
  let deltas = '';
  let doneText: string | null = null;
  const errors: ReplayArmResult['errors'] = [];
  const halts: ReplayArmResult['halts'] = [];
  for (const event of run.events) {
    if (event.type === 'text_delta') deltas += event.text;
    else if (event.type === 'done') doneText = event.text;
    else if (event.type === 'error') errors.push({ error: event.error, code: event.code });
    else if (event.type === 'halt') {
      halts.push({ kind: event.kind, rule: event.rule, message: event.message });
    }
  }
  const text = doneText ?? deltas;
  const plan = collectDryRunPlan(run.events);
  const completed = errors.length === 0 && halts.length === 0;

  const assertions: AssertionResult[] = [];
  for (const assertion of learningCase.assertions) {
    const scorer = scorerFor(assertion.kind, plan, grader);
    const score = await scorer(text, {
      id: learningCase.id,
      expected: assertion.value,
      match: 'llm',
    });
    assertions.push({ kind: assertion.kind, value: assertion.value, passed: score >= 1 });
  }
  assertions.push({ kind: 'completed', value: 'no error event and no halt', passed: completed });

  const passed = assertions.filter((a) => a.passed).length;
  return {
    arm,
    text,
    plan,
    errors,
    halts,
    costUsd: run.costUsd,
    completed,
    assertions,
    score: passed / assertions.length,
  };
}

function scorerFor(kind: AssertionKind, plan: DryRunToolPlan[], grader: LLMProvider): Scorer {
  switch (kind) {
    case 'criteria':
      return llmJudgeScorer(grader);
    case 'contains':
      return containsScorer;
    case 'regex':
      return regexScorer;
    case 'exact':
      return exactMatchScorer;
    case 'tool_called':
      return toolCalledScorer(plan, 'called');
    case 'tool_not_called':
      return toolCalledScorer(plan, 'not_called');
  }
}

/**
 * Replay one candidate. Never throws for a case that fails — a thrown arm, a
 * grader error, or the budget stops the run and the report says why, with
 * verdict `incomplete`. Throws only when `runOptions` is not a dry run.
 */
export async function runReplay(input: RunReplayInput): Promise<ReplayReport> {
  // The type already refuses this; a cast or a JS caller does not, and a
  // non-dry-run replay executes the candidate's tools for real (X-D6).
  if (input.runOptions.dryRun !== true || input.runOptions.temperature !== 0) {
    throw new Error('runReplay: runOptions must be { dryRun: true, temperature: 0 }');
  }
  const now = input.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const runId = newReplayRunId(now);

  const { selected, skipped } = selectReplayCases(
    input.targetCases,
    input.regressionPool,
    input.maxCases,
  );
  const cases: ReplayCaseResult[] = selected.map(({ role, case: c }) => ({
    caseId: c.id,
    role,
    source: c.source,
    sourceRef: c.sourceRef,
    prompt: c.prompt,
    baseline: null,
    candidate: null,
    delta: null,
  }));

  let costUsd = 0;
  let stopReason: ReplayStopReason | null = null;
  let error: string | null = null;

  // Mirrors `computeVerdict`'s rule (a): a target AND a regression case.
  const enough =
    selected.length >= MIN_REPLAY_CASES &&
    selected.some((s) => s.role === 'target') &&
    selected.some((s) => s.role === 'regression');
  // Spend nothing on a run that cannot reach `pass`.
  if (!enough) stopReason = 'insufficient_cases';

  const runArm = async (arm: ReplayArm, learningCase: LearningCase): Promise<ArmRun> => {
    const sessionKey = `replay:${input.candidateId}:${arm}:${learningCase.id}`;
    const session = input.newSession();
    const abort = new AbortController();
    const run: ArmRun = { events: [], costUsd: 0, overBudget: false };
    let runtime: ReplayArmRuntime | null = null;
    try {
      await seedContext(session, sessionKey, input.personalityId, learningCase.context);
      runtime = await input.createArm({
        arm,
        shadow: arm === 'candidate' ? input.shadow : null,
        session,
      });
      const options: ReplayTurnOptions = {
        ...input.runOptions,
        dryRunMaxToolCalls: REPLAY_DRY_RUN_MAX_TOOL_CALLS,
        sessionKey,
        personalityId: input.personalityId,
        abortSignal: abort.signal,
      };
      // Drained to exhaustion even after an abort: `done` is not the end of a
      // turn, and breaking out skips the loop's own turn tail.
      for await (const event of runtime.loop.run(learningCase.prompt, options)) {
        run.events.push(event);
        if (event.type !== 'usage') continue;
        run.costUsd += event.estimatedCostUsd;
        costUsd += event.estimatedCostUsd;
        if (costUsd > input.maxCostUsd && !abort.signal.aborted) {
          run.overBudget = true;
          abort.abort();
        }
      }
    } finally {
      await runtime?.dispose();
    }
    return run;
  };

  for (const [i, { case: learningCase }] of selected.entries()) {
    if (stopReason) break;
    const result = cases[i];
    if (!result) break;
    try {
      const baseline = await runArm('baseline', learningCase);
      if (baseline.overBudget) {
        stopReason = 'budget';
        break;
      }
      const candidate = await runArm('candidate', learningCase);
      if (candidate.overBudget) {
        stopReason = 'budget';
        break;
      }
      // Graded only once both arms ran: a budget stop spends no grader calls
      // on a case that cannot count.
      result.baseline = await scoreArm('baseline', learningCase, baseline, input.grader);
      result.candidate = await scoreArm('candidate', learningCase, candidate, input.grader);
      result.delta = result.candidate.score - result.baseline.score;
    } catch (err) {
      result.baseline = null;
      result.candidate = null;
      stopReason = 'error';
      error = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  const verdict = computeVerdict({
    cases: cases.map((c) => ({
      caseId: c.caseId,
      role: c.role,
      baseline: c.baseline,
      candidate: c.candidate,
    })),
    withinBudget: stopReason !== 'budget' && costUsd <= input.maxCostUsd,
  });

  return {
    ...verdict,
    runId,
    candidateId: input.candidateId,
    testedOn: input.personalityId,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    costUsd,
    maxCostUsd: input.maxCostUsd,
    stopReason,
    error,
    cases,
    skipped,
    limitations: REPLAY_LIMITATIONS,
  };
}

// --- The candidate-level entry point ---------------------------------------

/** Statuses a candidate may be replayed from. */
const REPLAYABLE: readonly CandidateStatus[] = ['pending_replay', 'pending_review'];

/**
 * Where a replay finds more REGRESSION cases when the frozen pool is short.
 * Wiring's `learningRegressionTopUp` binds it to the personality's recent
 * sessions (`packages/wiring/src/learning-pipeline.ts`). It feeds
 * `captureCases`' `sessionTurns` — the same path the nightly freeze uses — so
 * `LEARNING_EXCLUDED_KEY_PREFIXES`, `CASE_FREEZE_BATCH` and `CASE_POOL_CAP`
 * apply unchanged.
 */
export interface RegressionTopUp {
  /** The personality's Core, for the session-turn assertion. */
  core(personalityId: string): Promise<string>;
  /** Recent user turns, newest first. Excluded keys are dropped by `caseFromSessionTurn`. */
  sessionTurns(personalityId: string): Promise<SessionCaseTurn[]>;
}

export interface ReplayCandidateDeps {
  storage: Storage;
  dataDir: string;
  createArm: CreateReplayArm;
  newSession: () => SessionStore;
  grader: LLMProvider;
  runOptions: ReplayBaseRunOptions;
  /** `resolveLearningReplay(config)` from `@ethosagent/config`. `enabled` is the caller's gate. */
  settings: { maxCases: number; maxCostUsd: number };
  /** `shadowForCandidate` from `packages/wiring/src/learning-replay.ts`. */
  shadowFor: (candidate: LearningCandidate) => Promise<OverlayShadow>;
  /**
   * Absent → a short pool stays short and the run is `incomplete`. Present →
   * `replayCandidate` freezes regression cases from recent sessions first, but
   * only when `regressionShortfall` says rule (a) cannot otherwise hold.
   */
  regressionTopUp?: RegressionTopUp;
  /** Recorded on the audit line. */
  actor?: string;
  now?: () => number;
}

/**
 * Load a candidate and its cases, replay it, park the scorecard as
 * `replay-<runId>.json`, and record the verdict. A `pending_replay` candidate
 * moves to `pending_review`; any other replayable status keeps its status and
 * takes the new verdict. Promotion is not decided here.
 *
 * A target case id with no frozen file is listed in `skipped`.
 *
 * The regression top-up lives HERE, so every replay — `ethos learning replay`,
 * the web's Run replay, the nightly step and `--auto-approve` — goes through
 * the same one. It never touches target cases: targets are read only from
 * `targetCaseIds`, a frozen file is write-once (`freezeCase`), and the pool cap
 * never evicts a target of any non-terminal candidate — this one's or another's
 * (`cases.ts` `enforceCasePoolCap`). It does not lower rule (a):
 * when the sessions cannot fill the shortfall the run is still `incomplete`.
 */
export async function replayCandidate(
  deps: ReplayCandidateDeps,
  candidateId: string,
): Promise<{ candidate: LearningCandidate; report: ReplayReport }> {
  const { storage, dataDir } = deps;
  const current = await readCandidate(storage, dataDir, candidateId);
  if (!current) throw new Error(`No such learning candidate: ${candidateId}`);
  if (!REPLAYABLE.includes(current.status)) {
    throw new Error(
      `Learning candidate ${candidateId} is ${current.status}; only ${REPLAYABLE.join(' or ')} candidates are replayed`,
    );
  }

  const targets: LearningCase[] = [];
  const missing: SkippedCase[] = [];
  for (const id of current.targetCaseIds) {
    const c = await readCase(storage, dataDir, current.personalityId, id);
    if (c) targets.push(c);
    else missing.push({ caseId: id, reason: 'target case not found' });
  }
  let pool = await listCases(storage, dataDir, current.personalityId);
  if (deps.regressionTopUp && regressionShortfall(targets, pool, deps.settings.maxCases) > 0) {
    await topUpRegressionPool(deps, deps.regressionTopUp, current);
    pool = await listCases(storage, dataDir, current.personalityId);
  }

  const report = await runReplay({
    candidateId,
    personalityId: current.personalityId,
    shadow: await deps.shadowFor(current),
    targetCases: targets,
    regressionPool: pool,
    createArm: deps.createArm,
    newSession: deps.newSession,
    grader: deps.grader,
    runOptions: deps.runOptions,
    maxCases: deps.settings.maxCases,
    maxCostUsd: deps.settings.maxCostUsd,
    now: deps.now,
  });
  report.skipped.unshift(...missing);

  await writeReplayRun(storage, dataDir, candidateId, report.runId, report, deps.now);
  const candidate = await updateCandidate(
    storage,
    dataDir,
    candidateId,
    {
      status: current.status === 'pending_replay' ? 'pending_review' : current.status,
      verdict: report.verdict,
      actor: deps.actor ?? 'replay',
      reason: `replay ${report.runId}: ${report.verdict}${report.stopReason ? ` (${report.stopReason})` : ''}`,
    },
    deps.now,
  );
  return { candidate, report };
}

async function topUpRegressionPool(
  deps: ReplayCandidateDeps,
  topUp: RegressionTopUp,
  candidate: LearningCandidate,
): Promise<CaptureCasesResult> {
  const { personalityId } = candidate;
  return captureCases({
    storage: deps.storage,
    dataDir: deps.dataDir,
    personalityId,
    core: await topUp.core(personalityId),
    sessionTurns: () => topUp.sessionTurns(personalityId),
    ...(deps.now ? { now: deps.now } : {}),
  });
}
