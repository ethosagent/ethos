import type { AcceptanceSpec, GoalStore, Tool, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResult(value: unknown): ToolResult {
  return { ok: true, value: JSON.stringify(value, null, 2) };
}

type ErrorCode = Extract<ToolResult, { ok: false }>['code'];

function errorResult(error: string, code: ErrorCode): ToolResult {
  return { ok: false, error, code };
}

// ---------------------------------------------------------------------------
// goal_create
// ---------------------------------------------------------------------------

interface CreateArgs {
  title: string;
  goal_text: string;
  acceptance_spec?: {
    checks?: unknown[];
    rubric?: unknown[];
    threshold?: number;
  };
  max_attempts?: number;
  max_cost_usd?: number;
  deadline?: string;
}

function createGoalCreate(store: GoalStore): Tool {
  return {
    name: 'goal_create',
    description:
      'Create a new goal for async execution by a personality. ' +
      'Returns the created goal object with its ID and initial status.',
    toolset: 'goals',
    maxResultChars: 5000,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['title', 'goal_text'],
      properties: {
        title: { type: 'string', description: 'Short title for the goal' },
        goal_text: { type: 'string', description: 'Refined goal statement from intake' },
        acceptance_spec: {
          type: 'object',
          description:
            'AcceptanceSpec: { checks, rubric, threshold }. Optional — system derives if omitted.',
          properties: {
            checks: { type: 'array' },
            rubric: { type: 'array' },
            threshold: { type: 'number' },
          },
        },
        max_attempts: { type: 'number', description: 'Max retry attempts. Default 3.' },
        max_cost_usd: { type: 'number', description: 'Cost ceiling in USD.' },
        deadline: { type: 'string', description: 'ISO timestamp deadline.' },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as Partial<CreateArgs>;
      if (typeof args.title !== 'string' || args.title.length === 0) {
        return errorResult('title must be a non-empty string', 'input_invalid');
      }
      if (typeof args.goal_text !== 'string' || args.goal_text.length === 0) {
        return errorResult('goal_text must be a non-empty string', 'input_invalid');
      }
      if (
        args.max_attempts !== undefined &&
        (typeof args.max_attempts !== 'number' || !Number.isFinite(args.max_attempts))
      ) {
        return errorResult('max_attempts must be a finite number', 'input_invalid');
      }
      if (
        args.max_cost_usd !== undefined &&
        (typeof args.max_cost_usd !== 'number' || !Number.isFinite(args.max_cost_usd))
      ) {
        return errorResult('max_cost_usd must be a finite number', 'input_invalid');
      }
      if (args.deadline !== undefined && typeof args.deadline !== 'string') {
        return errorResult('deadline must be a string', 'input_invalid');
      }
      try {
        const userId = ctx.getContext?.('userId') ?? 'default-user';
        const goal = store.create({
          userId: typeof userId === 'string' ? userId : 'default-user',
          personalityId: ctx.personalityId ?? 'default',
          origin: 'web',
          title: args.title,
          goalText: args.goal_text,
          ...(args.acceptance_spec !== undefined
            ? { acceptanceCriteria: args.acceptance_spec as AcceptanceSpec }
            : {}),
          ...(args.max_attempts !== undefined ? { maxAttempts: args.max_attempts } : {}),
          ...(args.max_cost_usd !== undefined ? { maxCostUsd: args.max_cost_usd } : {}),
          ...(args.deadline !== undefined ? { deadline: args.deadline } : {}),
        });
        return jsonResult(goal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg, 'execution_failed');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// goal_status
// ---------------------------------------------------------------------------

interface StatusArgs {
  id?: string;
  limit?: number;
}

function createGoalStatus(store: GoalStore): Tool {
  return {
    name: 'goal_status',
    description: 'Check the status and output of a goal. Omit id to list recent goals.',
    toolset: 'goals',
    maxResultChars: 10_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Goal ID. Omit to list recent goals.' },
        limit: { type: 'number', description: 'Max goals to list when id is omitted. Default 10.' },
      },
    },
    async execute(rawArgs) {
      const args = (rawArgs ?? {}) as Partial<StatusArgs>;
      if (args.id !== undefined && typeof args.id !== 'string') {
        return errorResult('id must be a string', 'input_invalid');
      }
      if (
        args.limit !== undefined &&
        (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1)
      ) {
        return errorResult('limit must be a positive integer', 'input_invalid');
      }
      try {
        if (args.id) {
          const goal = store.get(args.id);
          if (!goal) return errorResult(`goal not found: ${args.id}`, 'input_invalid');
          return jsonResult(goal);
        }
        const limit = args.limit ?? 10;
        const goals = store.list({ limit });
        return jsonResult(goals);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg, 'execution_failed');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// goal_complete
// ---------------------------------------------------------------------------

interface CompleteArgs {
  summary: string;
  output_md: string;
  artifacts?: Record<string, unknown>;
}

function createGoalComplete(): Tool {
  return {
    name: 'goal_complete',
    description:
      'Mark the current goal as complete with a structured output. ' +
      'Only available inside goal runs.',
    toolset: 'goals',
    maxResultChars: 2000,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['summary', 'output_md'],
      properties: {
        summary: { type: 'string', description: 'One-line summary of the outcome' },
        output_md: { type: 'string', description: 'Full markdown output' },
        artifacts: { type: 'object', description: 'Optional structured artifacts' },
      },
    },
    async execute(rawArgs) {
      const args = (rawArgs ?? {}) as Partial<CompleteArgs>;
      if (typeof args.summary !== 'string' || args.summary.length === 0) {
        return errorResult('summary must be a non-empty string', 'input_invalid');
      }
      if (typeof args.output_md !== 'string' || args.output_md.length === 0) {
        return errorResult('output_md must be a non-empty string', 'input_invalid');
      }
      // The actual handling happens through the before_goal_complete claiming hook
      // in the GoalRunner. This tool just needs to exist so the LLM can call it.
      return { ok: true, value: 'Goal completion signaled.' };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGoalTools(store: GoalStore): Tool<unknown>[] {
  return [createGoalCreate(store), createGoalStatus(store), createGoalComplete()];
}
