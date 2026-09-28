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
