// plan personality-memory-boundary step 5, D20 — a kanban task a shared turn
// creates is stamped shared (`audienceStamp`), so the poll loop and the team
// dispatcher run it shared. The runners' side is pinned in
// apps/ethos/src/lib/__tests__/kanban-poll.test.ts ("room audience") and the room-audience
// cases in extensions/team-supervisor/src/__tests__/dispatcher.test.ts.

import { KanbanStore } from '@ethosagent/kanban-store';
import type {
  CompletionChunk,
  LLMProvider,
  Tool,
  ToolContext,
  TurnAudience,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKanbanTools } from '../index';

function ctx(roomAudience?: TurnAudience): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'telegram:bot:-100200',
    platform: 'telegram',
    workingDir: '/tmp',
    personalityId: 'lead',
    currentTurn: 0,
    messageCount: 0,
    abortSignal: new AbortController().signal,
    emit: () => undefined,
    resultBudgetChars: 80_000,
    ...(roomAudience ? { roomAudience } : {}),
  };
}

function decomposer(children: unknown[]): LLMProvider {
  return {
    name: 'stub',
    model: 'stub',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete(): AsyncIterable<CompletionChunk> {
      return (async function* () {
        yield { type: 'text_delta', text: JSON.stringify(children) } as CompletionChunk;
      })();
    },
    async countTokens() {
      return 0;
    },
  };
}

async function run(tool: Tool | undefined, args: unknown, c: ToolContext) {
  if (!tool) throw new Error('tool missing');
  const res = await tool.execute(args, c);
  if (!res.ok) throw new Error(res.error);
  return JSON.parse(res.value) as Record<string, unknown>;
}

describe('kanban task room audience', () => {
  let store: KanbanStore;
  let tools: Record<string, Tool>;

  beforeEach(() => {
    store = new KanbanStore(':memory:');
    tools = Object.fromEntries(
      createKanbanTools({ store, decomposerProvider: decomposer([{ title: 'child' }]) }).map(
        (t) => [t.name, t],
      ),
    );
  });
  afterEach(() => store.close());

  it('kanban_create from a group-chat turn is stamped shared', async () => {
    const out = await run(tools.kanban_create, { title: 't', assignee: 'eng' }, ctx('shared'));
    expect(store.getTask(String(out.task_id))?.roomAudience).toBe('shared');
  });

  it('kanban_create from a delegated child of a group turn (no origin) is stamped shared', async () => {
    const child: ToolContext = {
      ...ctx('shared'),
      sessionKey: 'telegram:bot:-100200:sub:task:1',
      platform: 'cli',
    };
    const out = await run(tools.kanban_create, { title: 't' }, child);
    expect(store.getTask(String(out.task_id))?.roomAudience).toBe('shared');
  });

  it('kanban_create from a private turn is stamped private', async () => {
    const out = await run(tools.kanban_create, { title: 't' }, ctx('private'));
    expect(store.getTask(String(out.task_id))?.roomAudience).toBe('private');
  });

  it('a hand-built context leaves the task unstamped', async () => {
    const out = await run(tools.kanban_create, { title: 't' }, ctx());
    expect(store.getTask(String(out.task_id))?.roomAudience).toBeUndefined();
  });

  it('kanban_create_goal and every task of a swarm are stamped', async () => {
    const goal = await run(tools.kanban_create_goal, { title: 'g' }, ctx('shared'));
    expect(store.getTask(String(goal.task_id))?.roomAudience).toBe('shared');
    const swarm = await run(
      tools.kanban_create_swarm,
      {
        goal: 'research',
        workers: [{ personality: 'a', prompt: 'p' }],
        verifier_personality: 'v',
        synthesizer_personality: 's',
      },
      ctx('shared'),
    );
    const ids = [
      swarm.root_id,
      ...(swarm.worker_ids as string[]),
      swarm.verifier_id,
      swarm.synthesizer_id,
    ].map(String);
    expect(ids.map((id) => store.getTask(id)?.roomAudience)).toEqual([
      'shared',
      'shared',
      'shared',
      'shared',
    ]);
  });

  it('kanban_decompose children of a shared task are shared, even from a private turn', async () => {
    const goal = await run(tools.kanban_create_goal, { title: 'g' }, ctx('shared'));
    const out = await run(tools.kanban_decompose, { task_id: goal.task_id }, ctx('private'));
    const [child] = out.children_created as Array<{ task_id: string }>;
    expect(store.getTask(child?.task_id ?? '')?.roomAudience).toBe('shared');
  });
});

// verification round E2 — a shared turn neither sees nor touches a task that
// is not stamped shared (`hiddenFrom`), and every refusal is the tool's own
// answer for a missing task, word for word.
describe('kanban tasks hidden from a shared turn', () => {
  let store: KanbanStore;
  let tools: Record<string, Tool>;

  beforeEach(() => {
    store = new KanbanStore(':memory:');
    tools = Object.fromEntries(
      createKanbanTools({ store, decomposerProvider: decomposer([{ title: 'child' }]) }).map(
        (t) => [t.name, t],
      ),
    );
  });
  afterEach(() => store.close());

  async function privateRunningTask(stamp?: TurnAudience): Promise<string> {
    const out = await run(
      tools.kanban_create,
      { title: 'secret plan', assignee: 'eng' },
      ctx(stamp),
    );
    const id = String(out.task_id);
    await run(tools.kanban_update_status, { task_id: id, status: 'running' }, ctx('private'));
    return id;
  }

  const MISSING = 'task-does-not-exist';
  const cases: Array<[string, (id: string) => Record<string, unknown>]> = [
    ['kanban_show', (id) => ({ task_id: id })],
    ['kanban_update_status', (id) => ({ task_id: id, status: 'blocked' })],
    ['kanban_comment', (id) => ({ task_id: id, body: 'from the room' })],
    ['kanban_complete', (id) => ({ task_id: id, summary: 's' })],
    ['kanban_block', (id) => ({ task_id: id, reason: 'r' })],
    ['kanban_unblock', (id) => ({ task_id: id })],
    ['kanban_heartbeat', (id) => ({ task_id: id })],
    ['kanban_assign', (id) => ({ task_id: id, assignee: 'other' })],
    ['kanban_archive', (id) => ({ task_id: id })],
    ['kanban_decompose', (id) => ({ task_id: id })],
    ['kanban_link', (id) => ({ parent_id: id, child_id: 'other-missing' })],
  ];

  for (const stamp of ['private', undefined] as const) {
    for (const [name, args] of cases) {
      it(`${name} answers a ${stamp ?? 'unstamped'} task as missing on a shared turn`, async () => {
        const id = await privateRunningTask(stamp);
        const before = JSON.stringify({
          task: store.getTask(id),
          comments: store.listComments(id),
        });
        const tool = tools[name];
        if (!tool) throw new Error(`missing ${name}`);
        const hidden = await tool.execute(args(id), ctx('shared'));
        const missing = await tool.execute(args(MISSING), ctx('shared'));
        expect(hidden.ok).toBe(false);
        expect(JSON.parse(JSON.stringify(hidden).replaceAll(id, MISSING))).toEqual(missing);
        expect(JSON.stringify({ task: store.getTask(id), comments: store.listComments(id) })).toBe(
          before,
        );
      });
    }
  }

  it('kanban_list on a shared turn leaves out private and unstamped tasks', async () => {
    await privateRunningTask('private');
    await privateRunningTask();
    const room = await run(tools.kanban_create, { title: 'room task' }, ctx('shared'));
    const listed = JSON.parse(
      await (async () => {
        const r = await tools.kanban_list?.execute({}, ctx('shared'));
        if (!r?.ok) throw new Error('list failed');
        return r.value;
      })(),
    ) as Array<{ id: string }>;
    expect(listed.map((t) => t.id)).toEqual([String(room.task_id)]);
  });

  it('a shared turn still acts on a shared task, and a private turn on every task', async () => {
    const shared = await run(tools.kanban_create, { title: 'room task' }, ctx('shared'));
    await run(tools.kanban_comment, { task_id: shared.task_id, body: 'ok' }, ctx('shared'));
    const priv = await privateRunningTask('private');
    await run(tools.kanban_comment, { task_id: priv, body: 'ok' }, ctx('private'));
    const shown = await run(tools.kanban_show, { task_id: priv }, ctx('private'));
    expect((shown.comments as unknown[]).length).toBe(1);
  });
});
