import { describe, expect, it } from 'vitest';
import { createTodoTools, InMemoryTodoStore } from '../index';

// End-to-end tests at the tool boundary — same level the LLM hits. Wraps
// the store but adds JSON serialization, schema-shape validation, and the
// MULTIPLE_IN_PROGRESS / NOT_FOUND → ToolResult mapping.
function makeCtx(sessionKey) {
  return {
    sessionId: sessionKey,
    sessionKey,
    platform: 'test',
    workingDir: '/tmp',
    currentTurn: 0,
    messageCount: 0,
    abortSignal: new AbortController().signal,
    emit: () => undefined,
    resultBudgetChars: 80_000,
  };
}
function toolsByName(tools) {
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}
async function call(tool, args, ctx) {
  const result = await tool.execute(args, ctx);
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return JSON.parse(result.value);
}
describe('todo tools', () => {
  it('every tool exposes the standard Tool contract', () => {
    const store = new InMemoryTodoStore();
    const tools = createTodoTools(store);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['todo_add', 'todo_clear', 'todo_list', 'todo_set', 'todo_update']);
    for (const t of tools) {
      expect(t.toolset).toBe('todo');
      expect(t.maxResultChars).toBe(2_000);
      expect(t.description).toMatch(/Exactly ONE task may be in_progress/);
    }
  });
  it('todo_set + todo_list round-trip yields the ids that were assigned', async () => {
    const store = new InMemoryTodoStore();
    const { todo_set, todo_list } = toolsByName(createTodoTools(store));
    const ctx = makeCtx('s1');
    const set = await call(
      todo_set,
      {
        todos: [
          { content: 'A', activeForm: 'Aing' },
          { content: 'B', activeForm: 'Bing' },
        ],
      },
      ctx,
    );
    expect(set).toEqual({ count: 2, ids: ['t1', 't2'] });
    const list = await call(todo_list, {}, ctx);
    expect(list.map((i) => i.id)).toEqual(['t1', 't2']);
    expect(list.every((i) => i.status === 'pending')).toBe(true);
  });
  it('todo_list default filter excludes completed', async () => {
    const store = new InMemoryTodoStore();
    const { todo_set, todo_update, todo_list } = toolsByName(createTodoTools(store));
    const ctx = makeCtx('s2');
    await call(
      todo_set,
      {
        todos: [
          { content: 'A', activeForm: 'A' },
          { content: 'B', activeForm: 'B' },
        ],
      },
      ctx,
    );
    await call(todo_update, { id: 't2', status: 'completed' }, ctx);
    const visible = await call(todo_list, {}, ctx);
    expect(visible.map((i) => i.id)).toEqual(['t1']);
    const allOfThem = await call(todo_list, { filter: 'all' }, ctx);
    expect(allOfThem.map((i) => i.id)).toEqual(['t1', 't2']);
  });
  it('second in_progress returns MULTIPLE_IN_PROGRESS via ToolResult (no throw)', async () => {
    const store = new InMemoryTodoStore();
    const { todo_set, todo_update } = toolsByName(createTodoTools(store));
    const ctx = makeCtx('s3');
    await call(
      todo_set,
      {
        todos: [
          { content: 'A', activeForm: 'A' },
          { content: 'B', activeForm: 'B' },
        ],
      },
      ctx,
    );
    await call(todo_update, { id: 't1', status: 'in_progress' }, ctx);
    const result = await todo_update.execute({ id: 't2', status: 'in_progress' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/Another task \(t1\) is already in_progress/);
    }
  });
  it('todo_update on unknown id returns input_invalid', async () => {
    const store = new InMemoryTodoStore();
    const { todo_update } = toolsByName(createTodoTools(store));
    const ctx = makeCtx('s4');
    const result = await todo_update.execute({ id: 't99', status: 'completed' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
  it('todo_add with notes > 500 chars surfaces notes_truncated:true in the result', async () => {
    const store = new InMemoryTodoStore();
    const { todo_add } = toolsByName(createTodoTools(store));
    const ctx = makeCtx('s5');
    const result = await call(
      todo_add,
      { content: 'A', activeForm: 'A', notes: 'x'.repeat(600) },
      ctx,
    );
    expect(result.notes_truncated).toBe(true);
  });
  it('todo_clear empties to count and resets the id counter', async () => {
    const store = new InMemoryTodoStore();
    const { todo_set, todo_clear, todo_add } = toolsByName(createTodoTools(store));
    const ctx = makeCtx('s6');
    await call(
      todo_set,
      {
        todos: [
          { content: 'A', activeForm: 'A' },
          { content: 'B', activeForm: 'B' },
        ],
      },
      ctx,
    );
    const cleared = await call(todo_clear, {}, ctx);
    expect(cleared).toEqual({ cleared: 2 });
    const added = await call(todo_add, { content: 'C', activeForm: 'C' }, ctx);
    expect(added.id).toBe('t1');
  });
  it('two sessions stay isolated through the tool surface', async () => {
    const store = new InMemoryTodoStore();
    const { todo_set, todo_list } = toolsByName(createTodoTools(store));
    await call(todo_set, { todos: [{ content: 'alpha', activeForm: 'alpha' }] }, makeCtx('a'));
    await call(todo_set, { todos: [{ content: 'beta', activeForm: 'beta' }] }, makeCtx('b'));
    const fromA = await call(todo_list, {}, makeCtx('a'));
    const fromB = await call(todo_list, {}, makeCtx('b'));
    expect(fromA.map((i) => i.content)).toEqual(['alpha']);
    expect(fromB.map((i) => i.content)).toEqual(['beta']);
  });
  it('input validation — todo_set with non-array rejects with input_invalid', async () => {
    const store = new InMemoryTodoStore();
    const { todo_set } = toolsByName(createTodoTools(store));
    const result = await todo_set.execute({ todos: 'not an array' }, makeCtx('s'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});
