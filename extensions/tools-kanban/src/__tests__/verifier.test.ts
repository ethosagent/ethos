import { DefaultHookRegistry } from '@ethosagent/core';
import { KanbanStore } from '@ethosagent/kanban-store';
import type { LLMProvider, Tool, ToolContext } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKanbanTools } from '../index';
import { createCompletionVerifier } from '../verifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake provider whose judge verdict is a fixed text_delta ('1' pass, '0' fail). */
function fakeProvider(verdict: string): LLMProvider {
  return {
    name: 'fake',
    model: 'fake-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete() {
      yield { type: 'text_delta' as const, text: verdict };
      yield { type: 'done' as const, finishReason: 'end_turn' as const };
    },
    async countTokens() {
      return 0;
    },
  };
}

function makeCtx(personalityId?: string): ToolContext {
  return {
    sessionId: 'sess',
    sessionKey: 'cli:test',
    platform: 'test',
    workingDir: '/tmp',
    ...(personalityId !== undefined ? { personalityId } : {}),
    currentTurn: 0,
    messageCount: 0,
    abortSignal: new AbortController().signal,
    emit: () => undefined,
    resultBudgetChars: 80_000,
  };
}

function toolsByName(tools: Tool[]): Record<string, Tool> {
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

async function call<T = unknown>(tool: Tool, args: unknown, ctx: ToolContext): Promise<T> {
  const result = await tool.execute(args, ctx);
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return JSON.parse(result.value) as T;
}

// ---------------------------------------------------------------------------
// createCompletionVerifier — unit tests
// ---------------------------------------------------------------------------

describe('createCompletionVerifier', () => {
  it('returns { handled: false } when the judge passes the summary', async () => {
    const verify = createCompletionVerifier({ getProvider: async () => fakeProvider('1') });
    const result = await verify({
      taskId: 't1',
      summary: 'shipped the feature with tests',
      acceptanceCriteria: 'feature is shipped with tests',
    });
    expect(result).toEqual({ handled: false });
  });

  it('rejects with the criteria in the reason when the judge fails the summary', async () => {
    const verify = createCompletionVerifier({ getProvider: async () => fakeProvider('0') });
    const result = await verify({
      taskId: 't1',
      summary: 'did some unrelated work',
      acceptanceCriteria: 'output must contain SHIPPED',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('acceptance criteria');
    expect(result.reason).toContain('output must contain SHIPPED');
  });

  it('skips verification entirely when the payload has no acceptanceCriteria', async () => {
    let providerRequested = false;
    const verify = createCompletionVerifier({
      getProvider: async () => {
        providerRequested = true;
        return fakeProvider('0');
      },
    });
    const result = await verify({ taskId: 't1', summary: 'anything goes' });
    expect(result).toEqual({ handled: false });
    // The provider is never constructed on the no-criteria path.
    expect(providerRequested).toBe(false);
  });

  it('fails closed when the provider throws', async () => {
    const verify = createCompletionVerifier({
      getProvider: async () => {
        throw new Error('provider unavailable');
      },
    });
    const result = await verify({
      taskId: 't1',
      summary: 'shipped',
      acceptanceCriteria: 'anything',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('fail-closed');
    expect(result.reason).toContain('provider unavailable');
  });

  it('fails closed when the completion stream throws mid-scoring', async () => {
    const broken: LLMProvider = {
      ...fakeProvider('1'),
      // biome-ignore lint/correctness/useYield: the throw before any yield is the point
      async *complete() {
        throw new Error('stream exploded');
      },
    };
    const verify = createCompletionVerifier({ getProvider: async () => broken });
    const result = await verify({
      taskId: 't1',
      summary: 'shipped',
      acceptanceCriteria: 'anything',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('fail-closed');
  });

  it('ignores autonomyTier — a trusted assignee still gets rejected on a fail verdict', async () => {
    const verify = createCompletionVerifier({ getProvider: async () => fakeProvider('0') });
    const result = await verify({
      taskId: 't1',
      summary: 'trust me, it works',
      acceptanceCriteria: 'output must contain SHIPPED',
      autonomyTier: 'trusted',
    });
    expect(result.handled).toBe(true);
  });

  it('truncates long acceptance criteria in the rejection reason', async () => {
    const verify = createCompletionVerifier({ getProvider: async () => fakeProvider('0') });
    const longCriteria = 'x'.repeat(1_000);
    const result = await verify({
      taskId: 't1',
      summary: 'nope',
      acceptanceCriteria: longCriteria,
    });
    expect(result.handled).toBe(true);
    expect(result.reason?.length ?? 0).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Integration — verifier registered as a real before_ticket_complete handler
// gating kanban_complete against a real store
// ---------------------------------------------------------------------------

describe('completion verifier gating kanban_complete', () => {
  let store: KanbanStore;

  beforeEach(() => {
    store = new KanbanStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('failing verdict sends the ticket to needs_revision; re-claim bumps retry_count', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerClaiming(
      'before_ticket_complete',
      createCompletionVerifier({ getProvider: async () => fakeProvider('0') }),
    );
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({
      title: 'verified task',
      acceptanceCriteria: 'output must contain SHIPPED',
      maxRetries: 3,
    });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'did some work' },
      makeCtx('engineer'),
    );
    expect(out.status).toBe('needs_revision');

    // The rejection reason landed in the audit trail.
    const reasons = store
      .listEvents(t.id)
      .filter((e) => e.kind === 'status_changed')
      .map((e) => e.data.reason);
    expect(reasons.some((r) => typeof r === 'string' && r.includes('acceptance criteria'))).toBe(
      true,
    );

    // Re-claim counts against the retry budget (store invariant, unchanged here).
    expect(store.getTask(t.id)?.retryCount).toBe(0);
    const reclaimed = store.updateStatus(t.id, 'running');
    expect(reclaimed.status).toBe('running');
    expect(reclaimed.retryCount).toBe(1);
  });

  it('a task without acceptanceCriteria completes straight to done', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerClaiming(
      'before_ticket_complete',
      createCompletionVerifier({ getProvider: async () => fakeProvider('0') }),
    );
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'plain task' });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'anything goes' },
      makeCtx('engineer'),
    );
    expect(out.status).toBe('done');
  });

  it('passing verdict completes the ticket to done', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerClaiming(
      'before_ticket_complete',
      createCompletionVerifier({ getProvider: async () => fakeProvider('1') }),
    );
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'verified task', acceptanceCriteria: 'SHIPPED' });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'work is SHIPPED' },
      makeCtx('engineer'),
    );
    expect(out.status).toBe('done');
  });
});
