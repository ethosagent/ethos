import type { TodoStatus, Tool, ToolResult } from '@ethosagent/types';
import {
  type AddPosition,
  type InMemoryTodoStore,
  MultipleInProgressError,
  TodoNotFoundError,
  type TodoUpdate,
} from './store';

export { InMemoryTodoStore } from './store';

// Rules block — shipped verbatim in every tool's description so the LLM
// sees them on every turn (Claude Code's documented approach for
// TodoWrite). Kept short enough to fit comfortably in the per-tool
// description budget.
const RULES = [
  '',
  'WHEN TO USE',
  '- Multi-step tasks with 3+ distinct actions',
  '- Users provide a list of items to work through',
  '- Non-trivial operations that benefit from progress tracking',
  '',
  'WHEN NOT TO USE',
  '- Single straightforward tasks or trivial work (<3 steps)',
  '- Purely conversational requests',
  '- Multi-agent / multi-personality coordination (use kanban instead)',
  '',
  'CRITICAL RULES',
  '- Exactly ONE task may be in_progress at any time',
  '- Mark tasks complete IMMEDIATELY when done — do NOT batch',
  '- Only mark complete when fully accomplished (tests pass, no errors)',
  '- If blocked: set notes:"BLOCKED: <reason>" on current task AND add a NEW pending task to resolve the blocker',
].join('\n');

const MAX_RESULT_CHARS = 2_000;

// JSON serializer — every tool returns structured output so the LLM can
// pattern-match. Two-space indent keeps tokens reasonable while staying
// human-readable for trace logs.
function jsonResult(value: unknown): ToolResult {
  return { ok: true, value: JSON.stringify(value, null, 2) };
}

type ToolErrorCode = Extract<ToolResult, { ok: false }>['code'];

function errorResult(error: string, code: ToolErrorCode): ToolResult {
  return { ok: false, error, code };
}

// ---------------------------------------------------------------------------
// todo_set — replace the whole list (start of a multi-step task)
// ---------------------------------------------------------------------------

interface SetArgs {
  todos: Array<{ content: string; activeForm: string }>;
}

function createTodoSet(store: InMemoryTodoStore): Tool {
  return {
    name: 'todo_set',
    description:
      'Replace the entire todo list with the supplied tasks. Resets the id counter. Use at the START of a multi-step task to lay out the plan.\n' +
      RULES,
    toolset: 'todo',
    maxResultChars: MAX_RESULT_CHARS,
    schema: {
      type: 'object',
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          description: 'New task list (replaces any existing items)',
          items: {
            type: 'object',
            required: ['content', 'activeForm'],
            properties: {
              content: {
                type: 'string',
                description: 'Imperative form, e.g. "Run the migration"',
              },
              activeForm: {
                type: 'string',
                description: 'Present-continuous form, e.g. "Running the migration"',
              },
            },
          },
        },
      },
    },
    async execute(rawArgs, ctx): Promise<ToolResult> {
      const args = (rawArgs ?? {}) as Partial<SetArgs>;
      if (!Array.isArray(args.todos)) {
        return errorResult('todos must be an array', 'input_invalid');
      }
      for (const t of args.todos) {
        if (!t || typeof t.content !== 'string' || typeof t.activeForm !== 'string') {
          return errorResult('each todo needs content + activeForm strings', 'input_invalid');
        }
      }
      const result = await store.set(ctx.sessionKey, args.todos);
      return jsonResult(result);
    },
  };
}

// ---------------------------------------------------------------------------
// todo_add — append (or insert) one task
// ---------------------------------------------------------------------------

interface AddArgs {
  content: string;
  activeForm: string;
  notes?: string;
  position?: AddPosition;
}

function createTodoAdd(store: InMemoryTodoStore): Tool {
  return {
    name: 'todo_add',
    description:
      'Add one task to the existing list. Use to extend a plan (e.g. when a blocker is discovered) without rewriting the whole list. notes is optional context (max 500 chars; clipped if longer).\n' +
      RULES,
    toolset: 'todo',
    maxResultChars: MAX_RESULT_CHARS,
    schema: {
      type: 'object',
      required: ['content', 'activeForm'],
      properties: {
        content: { type: 'string', description: 'Imperative form' },
        activeForm: { type: 'string', description: 'Present-continuous form' },
        notes: {
          type: 'string',
          description: 'Optional free-form context (max 500 chars; clipped if longer)',
        },
        position: {
          description: '"start" | "end" | numeric index (default "end"; clamps to [0, len])',
        },
      },
    },
    async execute(rawArgs, ctx): Promise<ToolResult> {
      const args = (rawArgs ?? {}) as Partial<AddArgs>;
      if (typeof args.content !== 'string' || typeof args.activeForm !== 'string') {
        return errorResult('content and activeForm must be strings', 'input_invalid');
      }
      const result = await store.add(ctx.sessionKey, {
        content: args.content,
        activeForm: args.activeForm,
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        ...(args.position !== undefined ? { position: args.position } : {}),
      });
      return jsonResult(result);
    },
  };
}

// ---------------------------------------------------------------------------
// todo_update — patch one task (status / content / activeForm / notes)
// ---------------------------------------------------------------------------

interface UpdateArgs extends TodoUpdate {
  id: string;
}

function createTodoUpdate(store: InMemoryTodoStore): Tool {
  return {
    name: 'todo_update',
    description:
      'Update one task. Omit fields to leave them unchanged. Flip status to "in_progress" when starting; flip to "completed" IMMEDIATELY after finishing.\n' +
      RULES,
    toolset: 'todo',
    maxResultChars: MAX_RESULT_CHARS,
    schema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Task id, e.g. "t1"' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
        },
        content: { type: 'string', description: 'New imperative form' },
        activeForm: { type: 'string', description: 'New present-continuous form' },
        notes: {
          type: 'string',
          description: 'Replace notes (max 500 chars; clipped if longer)',
        },
      },
    },
    async execute(rawArgs, ctx): Promise<ToolResult> {
      const args = (rawArgs ?? {}) as Partial<UpdateArgs>;
      if (typeof args.id !== 'string') {
        return errorResult('id must be a string', 'input_invalid');
      }
      const patch: TodoUpdate = {};
      if (args.status !== undefined) patch.status = args.status as TodoStatus;
      if (args.content !== undefined) patch.content = args.content;
      if (args.activeForm !== undefined) patch.activeForm = args.activeForm;
      if (args.notes !== undefined) patch.notes = args.notes;

      try {
        const result = await store.update(ctx.sessionKey, args.id, patch);
        return jsonResult(result);
      } catch (err) {
        if (err instanceof MultipleInProgressError) {
          return errorResult(err.message, 'execution_failed');
        }
        if (err instanceof TodoNotFoundError) {
          return errorResult(err.message, 'input_invalid');
        }
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// todo_list — read the list (default filter='open' = pending + in_progress)
// ---------------------------------------------------------------------------

interface ListArgs {
  filter?: 'open' | 'all' | 'pending' | 'in_progress' | 'completed';
}

function createTodoList(store: InMemoryTodoStore): Tool {
  return {
    name: 'todo_list',
    description:
      'Read the current todo list. Default filter is "open" (= pending + in_progress) so completed items do not push the model into re-doing finished work. Pass filter:"all" for the full list including completed.\n' +
      RULES,
    toolset: 'todo',
    maxResultChars: MAX_RESULT_CHARS,
    schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['open', 'all', 'pending', 'in_progress', 'completed'],
          description: 'Default "open" (= pending + in_progress)',
        },
      },
    },
    async execute(rawArgs, ctx): Promise<ToolResult> {
      const args = (rawArgs ?? {}) as Partial<ListArgs>;
      const filter = args.filter ?? 'open';
      return jsonResult(store.list(ctx.sessionKey, filter));
    },
  };
}

// ---------------------------------------------------------------------------
// todo_clear — empty the list and reset the id counter
// ---------------------------------------------------------------------------

function createTodoClear(store: InMemoryTodoStore): Tool {
  return {
    name: 'todo_clear',
    description:
      'Remove every task from the current session and reset the id counter to t1. Use when starting a fresh plan in the same session.\n' +
      RULES,
    toolset: 'todo',
    maxResultChars: MAX_RESULT_CHARS,
    schema: { type: 'object', properties: {} },
    async execute(_args, ctx): Promise<ToolResult> {
      const result = await store.clear(ctx.sessionKey);
      return jsonResult(result);
    },
  };
}

// ---------------------------------------------------------------------------
// Factory — wire all 5 tools to a single store instance per process
// ---------------------------------------------------------------------------

export function createTodoTools(store: InMemoryTodoStore): Tool[] {
  return [
    createTodoSet(store),
    createTodoAdd(store),
    createTodoUpdate(store),
    createTodoList(store),
    createTodoClear(store),
  ];
}
