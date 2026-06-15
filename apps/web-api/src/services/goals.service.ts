import { join } from 'node:path';
import { classifyGoal, GoalRunner } from '@ethosagent/goal-runner';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AcceptanceSpec, Goal, GoalAttempt, GoalEvent, SessionStore } from '@ethosagent/types';

export interface GoalsServiceOptions {
  dataDir: string;
  /** Shared loop-bearing runner from wiring's CreateAgentLoopResult. When provided,
   *  web-created goals execute on the same runner+store as the CLI/gateway path. */
  runner?: GoalRunner;
  /** Shared goal store — pass alongside `runner` so reads hit the same db handle. */
  store?: SQLiteGoalStore;
  /** Session store for reading tool-call results out of a goal's attempt
   *  sessions. When absent, `toolResult` returns `{ found: false }`. */
  sessionStore?: SessionStore;
}

export class GoalsService {
  private store: SQLiteGoalStore;
  private runner: GoalRunner;
  private sessionStore?: SessionStore;

  constructor(opts: GoalsServiceOptions) {
    this.store = opts.store ?? new SQLiteGoalStore(join(opts.dataDir, 'goals.db'));
    this.runner = opts.runner ?? new GoalRunner({ store: this.store });
    this.sessionStore = opts.sessionStore;
    // The injected runner already recovered orphans in build-agent-loop; only a
    // self-constructed (loop-less) runner needs to recover here.
    if (!opts.runner) this.runner.recoverOrphans();
  }

  async get(id: string): Promise<{ goal: Goal; events: GoalEvent[]; attempts: GoalAttempt[] }> {
    const goal = this.store.get(id);
    if (!goal) throw new Error(`Goal not found: ${id}`);
    const events = this.store.getEvents(id);
    const attempts = this.store.getAttempts(id);
    return { goal, events, attempts };
  }

  async list(opts?: { status?: string; limit?: number }): Promise<{ goals: Goal[] }> {
    const goals = this.store.list(opts as Parameters<SQLiteGoalStore['list']>[0]);
    return { goals };
  }

  async steer(id: string, message: string): Promise<{ ok: boolean }> {
    return { ok: this.runner.steer(id, message) };
  }

  async cancel(id: string): Promise<{ ok: boolean }> {
    return { ok: this.runner.cancel(id) };
  }

  async resume(id: string): Promise<{ ok: boolean }> {
    return { ok: await this.runner.resume(id) };
  }

  async create(input: {
    personalityId: string;
    goalText: string;
    title?: string;
    acceptanceCriteria?: {
      checks?: Array<{ description: string }>;
      rubric?: Array<{ description: string; weight: number }>;
      threshold?: number;
    };
    maxAttempts?: number;
    maxCostUsd?: number;
    deadline?: string;
    maxToolCallsPerTurn?: number;
    allowDangerousToolCalls?: boolean;
    maxRecoveryAttempts?: number;
  }): Promise<{ goal: Goal }> {
    const acceptanceCriteria: AcceptanceSpec | undefined = input.acceptanceCriteria
      ? {
          checks: (input.acceptanceCriteria.checks ?? []).map((c, i) => ({
            id: `check-${i}`,
            description: c.description,
          })),
          rubric: (input.acceptanceCriteria.rubric ?? []).map((r, i) => ({
            id: `rubric-${i}`,
            description: r.description,
            weight: r.weight,
          })),
          threshold: input.acceptanceCriteria.threshold ?? 0.8,
        }
      : undefined;

    const goal = this.store.create({
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
      ...(input.allowDangerousToolCalls !== undefined
        ? { allowDangerousToolCalls: input.allowDangerousToolCalls }
        : {}),
      ...(input.maxRecoveryAttempts !== undefined
        ? { maxRecoveryAttempts: input.maxRecoveryAttempts }
        : {}),
    });
    await this.runner.startGoal(goal.id);
    return { goal };
  }

  async getGoal(id: string): Promise<Goal | null> {
    return this.store.get(id);
  }

  async getEvents(goalId: string): Promise<GoalEvent[]> {
    return this.store.getEvents(goalId);
  }

  async getEventsSince(goalId: string, afterSeq: number): Promise<GoalEvent[]> {
    const events = this.store.getEvents(goalId);
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

    const attempts = this.store.getAttempts(goalId);
    for (const attempt of attempts) {
      const session = await store.getSessionByKey(attempt.sessionKey);
      if (!session) continue;
      const messages = await store.getMessages(session.id);

      const resultMsg = messages.find(
        (m) => m.role === 'tool_result' && m.toolCallId === toolCallId,
      );
      if (!resultMsg) continue;

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
        output: resultMsg.content,
      };
    }

    return { found: false };
  }

  async classify(message: string) {
    return classifyGoal(message);
  }
}
