// ---------------------------------------------------------------------------
// Goal status
// ---------------------------------------------------------------------------

export type GoalStatus =
  | 'planning'
  | 'running'
  | 'judging'
  | 'retrying'
  | 'needs_clarification'
  | 'completed'
  | 'exhausted'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

// ---------------------------------------------------------------------------
// AcceptanceSpec — captured at intake, immutable during the run
// ---------------------------------------------------------------------------

export interface AcceptanceCheck {
  id: string;
  description: string;
  /** Shell command or pattern match that must exit 0 / match. */
  command?: string;
}

export interface AcceptanceRubric {
  id: string;
  description: string;
  weight: number;
}

export interface AcceptanceSpec {
  checks: AcceptanceCheck[];
  rubric: AcceptanceRubric[];
  /** Weighted rubric score threshold for convergence. Default 0.8. */
  threshold: number;
}

// ---------------------------------------------------------------------------
// Verdict — emitted by the Judge after each attempt
// ---------------------------------------------------------------------------

export interface CriterionResult {
  id: string;
  /** true for checks, 0–1 for rubric items */
  pass?: boolean;
  score?: number;
  evidence: string;
  gap?: string;
}

export interface Verdict {
  score: number;
  perCriterion: CriterionResult[];
}

// ---------------------------------------------------------------------------
// Goal attempt — one row per convergence-loop iteration
// ---------------------------------------------------------------------------

export interface GoalAttempt {
  id: string;
  goalId: string;
  n: number;
  sessionKey: string;
  outputMd: string | null;
  artifacts: unknown | null;
  verdict: Verdict | null;
  strategyUsed: 'first' | 'patch' | 'pivot';
  costUsd: number | null;
  traceId: string | null;
  startedAt: number;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export type GoalOrigin = 'web' | 'cli' | string;

export interface Goal {
  id: string;
  userId: string;
  personalityId: string;
  origin: GoalOrigin;
  sourceSession: string | null;
  title: string;
  goalText: string;
  acceptanceCriteria: AcceptanceSpec | null;
  /** The plan produced by the mandatory planning phase, as free-form markdown.
   *  Null until planning completes (or when the runner is wired without a
   *  planning callback, e.g. store-only / test construction). */
  planMd: string | null;
  status: GoalStatus;
  maxAttempts: number;
  maxCostUsd: number | null;
  deadline: string | null;
  outputMd: string | null;
  outputPartial: string | null;
  errorText: string | null;
  startedAt: number;
  completedAt: number | null;
  resumeCount: number;
  turnCount: number | null;
  toolCount: number | null;
  tokenCount: number | null;
  costUsd: number | null;
  maxToolCallsPerTurn?: number;
  maxIdenticalToolCalls?: number;
  allowDangerousToolCalls?: boolean;
  maxRecoveryAttempts?: number;
}

// ---------------------------------------------------------------------------
// Goal event — structural events for the journey graph
// ---------------------------------------------------------------------------

export type GoalEventType =
  | 'run_start'
  | 'plan_start'
  | 'plan_ready'
  | 'attempt_start'
  | 'turn_text'
  | 'tool_start'
  | 'tool_end'
  | 'steer'
  | 'usage'
  | 'complete_attempt'
  | 'complete_rejected'
  | 'error'
  | 'done';

export interface GoalEvent {
  id: number;
  goalId: string;
  seq: number;
  eventType: GoalEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// GoalStore — persistence contract
// ---------------------------------------------------------------------------

export interface CreateGoalInput {
  userId: string;
  personalityId: string;
  origin: GoalOrigin;
  sourceSession?: string | null;
  title: string;
  goalText: string;
  acceptanceCriteria?: AcceptanceSpec | null;
  maxAttempts?: number;
  maxCostUsd?: number | null;
  deadline?: string | null;
  maxToolCallsPerTurn?: number;
  maxIdenticalToolCalls?: number;
  allowDangerousToolCalls?: boolean;
  maxRecoveryAttempts?: number;
}

export interface GoalStore {
  create(input: CreateGoalInput): Goal;
  get(id: string): Goal | null;
  list(opts?: { userId?: string; status?: GoalStatus; limit?: number }): Goal[];
  updateStatus(
    id: string,
    status: GoalStatus,
    extra?: Partial<
      Pick<
        Goal,
        | 'outputMd'
        | 'outputPartial'
        | 'errorText'
        | 'completedAt'
        | 'turnCount'
        | 'toolCount'
        | 'tokenCount'
        | 'costUsd'
        | 'planMd'
      >
    >,
  ): void;
  appendEvent(goalId: string, eventType: GoalEventType, payload: Record<string, unknown>): void;
  getEvents(goalId: string): GoalEvent[];
  saveAttempt(attempt: Omit<GoalAttempt, 'id'>): GoalAttempt;
  updateAttempt(
    goalId: string,
    n: number,
    patch: Partial<Pick<GoalAttempt, 'verdict' | 'outputMd' | 'costUsd' | 'completedAt'>>,
  ): void;
  getAttempts(goalId: string): GoalAttempt[];
  incrementResumeCount(id: string): void;
}

// ---------------------------------------------------------------------------
// Hook payload for before_goal_complete (claiming hook)
// ---------------------------------------------------------------------------

export interface BeforeGoalCompletePayload {
  goalId: string;
  summary: string;
  outputMd: string;
  acceptanceCriteria: AcceptanceSpec | null;
}

export interface BeforeGoalCompleteResult {
  /** true = this handler rejects the completion (claiming semantics). */
  handled: boolean;
  /** Why the completion was rejected. Required when handled is true. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Goal notification payloads (void hooks)
// ---------------------------------------------------------------------------

export interface GoalCompletedPayload {
  goalId: string;
  title: string;
  summary: string;
  outputMd: string;
  origin: GoalOrigin;
  personalityId: string;
  costUsd: number | null;
  durationMs: number;
}

export interface GoalFailedPayload {
  goalId: string;
  title: string;
  errorText: string | null;
  outputPartial: string | null;
  origin: GoalOrigin;
  personalityId: string;
}

export interface GoalExhaustedPayload {
  goalId: string;
  title: string;
  bestAttemptOutput: string | null;
  verdict: Verdict | null;
  origin: GoalOrigin;
  personalityId: string;
}

export interface GoalNeedsClarificationPayload {
  goalId: string;
  reason: string;
}
