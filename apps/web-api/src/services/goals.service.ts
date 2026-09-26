import {
  type AcceptanceSpec,
  EthosError,
  type Goal,
  type GoalAttempt,
  type GoalEvent,
  type GoalStore,
  RETURNED_DIRECT_TOOL_RESULT,
  type SessionStore,
} from '@ethosagent/types';

/**
 * The run-control half of the goal backend — exactly what GoalsService calls.
 * Structural, so web-api never names the concrete runner (ARCHITECTURE.md
 * Law 5): `GoalRunner` from `@ethosagent/goal-runner` satisfies it, and wiring
 * hands one over as `CreateAgentLoopResult.goals.executor`.
 */
export interface GoalExecutor {
  /** True only when `startGoal`/`resume` will actually execute attempts
   *  (`GoalRunner.canExecute`: a loop-bearing `runAttempt` is wired). */
  canExecute(): boolean;
  startGoal(goalId: string): Promise<void>;
  steer(goalId: string, message: string): boolean;
  cancel(goalId: string): boolean;
  resume(goalId: string): Promise<boolean>;
}

/**
 * A goal store and the executor that runs goals FROM that store, built
 * together by wiring (`buildAgentLoop` → `CreateAgentLoopResult.goals`). Pinned
 * by `accepts wiring's CreateAgentLoopResult.goals` in
 * `__tests__/goals-backend.test.ts`.
 */
export interface GoalsBackend {
  store: GoalStore;
  executor: GoalExecutor;
}

export interface GoalsServiceOptions {
  /** Borrowed from the composition root — GoalsService never constructs a
   *  store or runner of its own, and never disposes this pair. Absent
   *  (onboarding, hosts without a loop) → reads are empty and create/resume
   *  are refused with `NOT_CONFIGURED`. */
  goals?: GoalsBackend;
  /**
   * The pair a goal for this personality runs on, when it is not the main one:
   * a team personality's goal belongs on its TEAM's loop (`ctx.teamId`, the
   * team board, team memory) — the same resolution a chat turn makes through
   * `loopForPersonality`. Returning undefined means "the main pair".
   */
  goalsFor?: (personalityId: string) => Promise<GoalsBackend | undefined>;
  /** Session store for reading tool-call results out of a goal's attempt
   *  sessions. When absent, `toolResult` returns `{ found: false }`. */
  sessionStore?: SessionStore;
  /**
   * Whether a check may carry a `command`, which the goal judge runs via
   * `sh -c` on the HOST, outside the sandbox (`defaultExecCommand`,
   * extensions/goal-runner/src/judge.ts). Wired to
   * `ConfigService.goalCheckCommandsAllowed` (`goals.allowCheckCommands`).
   * Absent → false: a create carrying a command is refused.
   */
  allowCheckCommands?: () => Promise<boolean>;
}

/** The refusal `create` throws for a command check while the key is off. */
function checkCommandsDisabled(): EthosError {
  return new EthosError({
    code: 'FORBIDDEN',
    cause:
      'Check commands are disabled. Set goals.allowCheckCommands: true in ~/.ethos/config.yaml to allow host shell commands in goal checks.',
    action: 'Remove the verify command from each check, or enable goals.allowCheckCommands.',
  });
}

export class GoalsService {
  private goals: GoalsBackend | undefined;
  private readonly goalsFor: GoalsServiceOptions['goalsFor'];
  private sessionStore?: SessionStore;
  private readonly allowCheckCommands: () => Promise<boolean>;

  constructor(opts: GoalsServiceOptions) {
    this.goals = opts.goals;
    this.allowCheckCommands = opts.allowCheckCommands ?? (async () => false);
    this.goalsFor = opts.goalsFor;
    this.sessionStore = opts.sessionStore;
  }

  /** The pair a goal for `personalityId` belongs to: its team's, else the main one. */
  private async backendFor(personalityId: string | undefined): Promise<GoalsBackend | undefined> {
    if (personalityId === undefined) return this.goals;
    return (await this.goalsFor?.(personalityId)) ?? this.goals;
  }

  /** The pair that owns an EXISTING goal — resolved from the personality it was created for. */
  private async backendOf(goalId: string): Promise<GoalsBackend | undefined> {
    return this.backendFor(this.goals?.store.get(goalId)?.personalityId);
  }

  /**
   * The backend, but only if it will actually run a goal. Checked before any
   * row is written, so an unavailable executor can never leave a `running`
   * goal that nothing executes (pinned in `__tests__/goals-backend.test.ts`).
   */
  private requireExecution(goals: GoalsBackend | undefined): GoalsBackend {
    if (!goals?.executor.canExecute()) {
      throw new EthosError({
        code: 'NOT_CONFIGURED',
        cause: 'Goal execution is not available on this server.',
        action: 'Finish setup so the server runs an agent loop, then start the goal again.',
      });
    }
    return goals;
  }

  async get(id: string): Promise<{ goal: Goal; events: GoalEvent[]; attempts: GoalAttempt[] }> {
    const store = this.goals?.store;
    const goal = store?.get(id);
    if (!store || !goal) throw new Error(`Goal not found: ${id}`);
    const events = store.getEvents(id);
    const attempts = store.getAttempts(id);
    return { goal, events, attempts };
  }

  async list(opts?: { status?: string; limit?: number }): Promise<{ goals: Goal[] }> {
    const goals = this.goals?.store.list(opts as Parameters<GoalStore['list']>[0]) ?? [];
    return { goals };
  }

  async steer(id: string, message: string): Promise<{ ok: boolean }> {
    const goals = await this.backendOf(id);
    return { ok: goals?.executor.steer(id, message) ?? false };
  }

  async cancel(id: string): Promise<{ ok: boolean }> {
    const goals = await this.backendOf(id);
    return { ok: goals?.executor.cancel(id) ?? false };
  }

  async resume(id: string): Promise<{ ok: boolean }> {
    return { ok: await this.requireExecution(await this.backendOf(id)).executor.resume(id) };
  }

  /** Settings the goal creation form needs before it renders. */
  async settings(): Promise<{ allowCheckCommands: boolean }> {
    return { allowCheckCommands: await this.allowCheckCommands() };
  }

  async create(input: {
    personalityId: string;
    goalText: string;
    title?: string;
    acceptanceCriteria?: {
      checks?: Array<{ description: string; command?: string }>;
      rubric?: Array<{ description: string; weight: number }>;
      threshold?: number;
    };
    maxAttempts?: number;
    maxCostUsd?: number;
    deadline?: string;
    maxToolCallsPerTurn?: number;
    maxIdenticalToolCalls?: number;
    allowDangerousToolCalls?: boolean;
    maxRecoveryAttempts?: number;
  }): Promise<{ goal: Goal }> {
    const { store, executor } = this.requireExecution(await this.backendFor(input.personalityId));
    // Refuse the WHOLE create rather than drop the command: a check the user
    // wrote as "run this" must never be silently judged some other way.
    const hasCommand = (input.acceptanceCriteria?.checks ?? []).some(
      (c) => (c.command ?? '').trim() !== '',
    );
    if (hasCommand && !(await this.allowCheckCommands())) throw checkCommandsDisabled();
    const acceptanceCriteria: AcceptanceSpec | undefined = input.acceptanceCriteria
      ? {
          checks: (input.acceptanceCriteria.checks ?? []).map((c, i) => {
            const command = c.command?.trim();
            return {
              id: `check-${i}`,
              description: c.description,
              ...(command ? { command } : {}),
            };
          }),
          rubric: (input.acceptanceCriteria.rubric ?? []).map((r, i) => ({
            id: `rubric-${i}`,
            description: r.description,
            weight: r.weight,
          })),
          threshold: input.acceptanceCriteria.threshold ?? 0.8,
        }
      : undefined;

    const goal = store.create({
      userId: 'default-user',
      personalityId: input.personalityId,
      origin: 'web',
      title: input.title ?? input.goalText.slice(0, 80),
      goalText: input.goalText,
      ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
      ...(input.maxToolCallsPerTurn !== undefined
        ? { maxToolCallsPerTurn: input.maxToolCallsPerTurn }
        : {}),
      ...(input.maxIdenticalToolCalls !== undefined
        ? { maxIdenticalToolCalls: input.maxIdenticalToolCalls }
        : {}),
      ...(input.allowDangerousToolCalls !== undefined
        ? { allowDangerousToolCalls: input.allowDangerousToolCalls }
        : {}),
      ...(input.maxRecoveryAttempts !== undefined
        ? { maxRecoveryAttempts: input.maxRecoveryAttempts }
        : {}),
    });
    await executor.startGoal(goal.id);
    return { goal };
  }

  async getGoal(id: string): Promise<Goal | null> {
    return this.goals?.store.get(id) ?? null;
  }

  async getEvents(goalId: string): Promise<GoalEvent[]> {
    return this.goals?.store.getEvents(goalId) ?? [];
  }

  async getEventsSince(goalId: string, afterSeq: number): Promise<GoalEvent[]> {
    const events = this.goals?.store.getEvents(goalId) ?? [];
    return events.filter((e) => e.seq > afterSeq);
  }

  /**
   * Read the real output of a tool call from a goal's attempt sessions.
   * The `tool_end` AgentEvent intentionally omits results; the authoritative
   * text lives as a `tool_result` message row in the attempt's session. We
   * scan each attempt's session for the row whose `toolCallId` matches, and
   * (best-effort) read the args/name from the assistant message that issued
   * the call. Returns `{ found: false }` when no session store is wired or
   * the call id is not located.
   */
  async toolResult(
    goalId: string,
    toolCallId: string,
  ): Promise<{ found: boolean; toolName?: string; input?: string; output?: string }> {
    const store = this.sessionStore;
    if (!store) return { found: false };

    const attempts = this.goals?.store.getAttempts(goalId) ?? [];
    for (const attempt of attempts) {
      const session = await store.getSessionByKey(attempt.sessionKey);
      if (!session) continue;
      const messages = await store.getMessages(session.id);

      const resultIdx = messages.findIndex(
        (m) => m.role === 'tool_result' && m.toolCallId === toolCallId,
      );
      const resultMsg = messages[resultIdx];
      if (!resultMsg) continue;
      // A returnDirect call's value is stored once, as the next assistant row;
      // its own row holds only the marker (RETURNED_DIRECT_TOOL_RESULT).
      const output =
        resultMsg.content === RETURNED_DIRECT_TOOL_RESULT
          ? (messages.slice(resultIdx + 1).find((m) => m.role === 'assistant')?.content ??
            resultMsg.content)
          : resultMsg.content;

      // Best-effort: pull args + name from the assistant message that issued
      // the call. The result row also carries toolName as a fallback.
      let toolName = resultMsg.toolName;
      let input: string | undefined;
      for (const m of messages) {
        const call = m.toolCalls?.find((c) => c.id === toolCallId);
        if (call) {
          toolName = call.name ?? toolName;
          input = JSON.stringify(call.input, null, 2);
          break;
        }
      }

      return {
        found: true,
        ...(toolName !== undefined ? { toolName } : {}),
        ...(input !== undefined ? { input } : {}),
        output,
      };
    }

    return { found: false };
  }
}
