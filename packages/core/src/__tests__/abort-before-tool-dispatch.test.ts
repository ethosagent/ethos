// An abort (`/stop`, voice barge-in) must stop the tools the model asked for in
// the same LLM response, not only the next LLM call.
//
// The loop checks `abortSignal.aborted` at the top of each iteration and
// streamStep breaks out of the stream on it — but a response whose `tool_use`
// blocks arrived BEFORE the abort still returned `outcome: 'tool-calls'`, and
// the loop went straight on into `before_tool_call` hooks, `tool_start` and
// `executeParallel`. The iteration-top check only fired after the tools had
// run. So the tools the user had just cancelled ran anyway.

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  StoredMessage,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultHookRegistry } from '../hook-registry';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { ABORTED_TOOL_RESULT, DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

/**
 * One scripted LLM call. `abortAfterToolUse` aborts the turn's controller from
 * INSIDE the stream, after the `tool_use` blocks and the usage chunk have been
 * yielded — the moment a barge-in lands mid-response.
 */
function scriptedLLM(
  chunks: CompletionChunk[],
  abortAfterToolUse?: AbortController,
): LLMProvider & { calls: () => number } {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    calls: () => calls,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      for (const c of chunks) yield c;
      abortAfterToolUse?.abort();
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function toolUse(id: string, json: string): CompletionChunk[] {
  return [
    { type: 'tool_use_start', toolCallId: id, toolName: 'deploy' },
    { type: 'tool_use_end', toolCallId: id, inputJson: json },
  ];
}

const USAGE: CompletionChunk = {
  type: 'usage',
  usage: {
    inputTokens: 50,
    outputTokens: 7,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0.01,
  },
};

function deployTool(): { tools: DefaultToolRegistry; executed: unknown[] } {
  const executed: unknown[] = [];
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'deploy',
    description: 'deploys',
    schema: { type: 'object' },
    capabilities: {},
    async execute(args): Promise<ToolResult> {
      executed.push(args);
      return { ok: true, value: 'deployed' };
    },
  });
  return { tools, executed };
}

function traceRecorder(): { observability: AgentLoopObservability; endStatuses: string[] } {
  const endStatuses: string[] = [];
  const observability: AgentLoopObservability = {
    startTurnTrace: () => 'trace-1',
    endTrace: (_id, status) => {
      endStatuses.push(status);
    },
    startSpan: () => 'span-1',
    endSpan: () => {},
    recordSafetyBlock: () => {},
    recordCompaction: () => {},
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
  return { observability, endStatuses };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

async function history(session: InMemorySessionStore, key: string): Promise<StoredMessage[]> {
  const s = await session.getSessionByKey(key);
  if (!s) throw new Error(`no session for ${key}`);
  return session.getMessages(s.id);
}

/** Every persisted tool_use has exactly one matching tool_result (Anthropic contract). */
function expectToolContractIntact(messages: StoredMessage[]): void {
  const toolUseIds = messages.flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id));
  const resultIds = messages.filter((m) => m.role === 'tool_result').map((m) => m.toolCallId);
  expect(resultIds.sort()).toEqual([...toolUseIds].sort());
}

describe('abort before tool dispatch', () => {
  it('runs none of the tools a response requested before the abort landed', async () => {
    const controller = new AbortController();
    const llm = scriptedLLM(
      [
        { type: 'text_delta', text: 'Deploying both.' },
        ...toolUse('t1', '{"target":"staging"}'),
        ...toolUse('t2', '{"target":"prod"}'),
        USAGE,
      ],
      controller,
    );
    const { tools, executed } = deployTool();
    const hooks = new DefaultHookRegistry();
    let beforeToolCallFired = 0;
    hooks.registerModifying('before_tool_call', async () => {
      beforeToolCallFired++;
      return null;
    });
    const session = new InMemorySessionStore();
    const { observability, endStatuses } = traceRecorder();
    const loop = new AgentLoop({
      llm,
      tools,
      hooks,
      session,
      observability,
      safety: createTestSafety(),
    });

    const events = await drain(
      loop.run('deploy it', { sessionKey: 'cli:abort-tools', abortSignal: controller.signal }),
    );

    // Nothing ran, and nothing was even offered to the approval surface.
    expect(executed).toEqual([]);
    expect(beforeToolCallFired).toBe(0);
    expect(events.some((e) => e.type === 'tool_start')).toBe(false);
    expect(llm.calls()).toBe(1);

    // The turn ends on the ordinary abort exit.
    const last = events.at(-1);
    expect(last).toEqual({ type: 'error', error: 'Aborted', code: 'aborted' });
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(endStatuses).toEqual(['aborted']);

    // The call that WAS made is billed: the rollup got its usage.
    const s = await session.getSessionByKey('cli:abort-tools');
    expect(s?.usage.inputTokens).toBe(50);
    expect(s?.usage.outputTokens).toBe(7);

    // History replays: both persisted tool_use blocks have an is_error result.
    const messages = await history(session, 'cli:abort-tools');
    expectToolContractIntact(messages);
    const results = messages.filter((m) => m.role === 'tool_result');
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.isError).toBe(true);
      expect(r.content).toBe(ABORTED_TOOL_RESULT);
      expect(r.toolName).toBe('deploy');
    }
  });

  it('does not dispatch a call whose before_tool_call hook resolved after the abort', async () => {
    // An approval hook parks on a human. The user /stops while it is parked;
    // the human (or the hook's own timeout) then answers "allow". The call must
    // not run on a turn that no longer exists.
    const controller = new AbortController();
    const llm = scriptedLLM(toolUse('t1', '{"target":"prod"}'));
    const { tools, executed } = deployTool();
    const hooks = new DefaultHookRegistry();
    hooks.registerModifying('before_tool_call', async () => {
      controller.abort();
      return null;
    });
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm, tools, hooks, session, safety: createTestSafety() });

    const events = await drain(
      loop.run('deploy it', { sessionKey: 'cli:abort-approval', abortSignal: controller.signal }),
    );

    expect(executed).toEqual([]);
    expect(events.some((e) => e.type === 'tool_start')).toBe(false);
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toMatchObject({ toolCallId: 't1', ok: false, error: ABORTED_TOOL_RESULT });
    expect(events.at(-1)).toEqual({ type: 'error', error: 'Aborted', code: 'aborted' });
    expect(llm.calls()).toBe(1);

    const messages = await history(session, 'cli:abort-approval');
    expectToolContractIntact(messages);
    expect(messages.find((m) => m.role === 'tool_result')?.isError).toBe(true);
  });

  it('a /stop while call 1 is parked in its hook fires no later hook and announces no tool_start', async () => {
    // Call 1's approval hook is parked when the user /stops. The remaining
    // calls in the batch must not fire their own hooks — each would be a fresh
    // approval prompt after /stop — and no call may announce a tool_start.
    const controller = new AbortController();
    const llm = scriptedLLM([
      ...toolUse('t1', '{"target":"staging"}'),
      ...toolUse('t2', '{"target":"prod"}'),
      ...toolUse('t3', '{"target":"dr"}'),
    ]);
    const { tools, executed } = deployTool();
    const hooks = new DefaultHookRegistry();
    const hookedCalls: string[] = [];
    hooks.registerModifying('before_tool_call', async (payload) => {
      hookedCalls.push(payload.toolCallId);
      controller.abort();
      return null;
    });
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm, tools, hooks, session, safety: createTestSafety() });

    const events = await drain(
      loop.run('deploy all', { sessionKey: 'cli:abort-mid-batch', abortSignal: controller.signal }),
    );

    expect(executed).toEqual([]);
    expect(hookedCalls).toEqual(['t1']);
    expect(events.some((e) => e.type === 'tool_start')).toBe(false);
    const ends = events.filter((e) => e.type === 'tool_end');
    expect(ends.map((e) => (e.type === 'tool_end' ? e.toolCallId : ''))).toEqual([
      't1',
      't2',
      't3',
    ]);
    for (const e of ends) expect(e).toMatchObject({ ok: false, error: ABORTED_TOOL_RESULT });
    expect(events.at(-1)).toEqual({ type: 'error', error: 'Aborted', code: 'aborted' });
    expect(llm.calls()).toBe(1);

    const messages = await history(session, 'cli:abort-mid-batch');
    expectToolContractIntact(messages);
    const results = messages.filter((m) => m.role === 'tool_result');
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.isError).toBe(true);
  });
});

describe('DefaultToolRegistry.executeParallel on an aborted signal', () => {
  it('returns an error result without executing, and caches nothing', async () => {
    let executions = 0;
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'cached_lookup',
      description: 'cached',
      schema: { type: 'object' },
      capabilities: {},
      cache: true,
      async execute(): Promise<ToolResult> {
        executions++;
        return { ok: true, value: 'fresh' };
      },
    });
    const aborted = new AbortController();
    aborted.abort();
    const base: Omit<ToolContext, 'abortSignal'> = {
      sessionId: 's',
      sessionKey: 'k',
      platform: 'cli',
      workingDir: '/tmp',
      currentTurn: 1,
      messageCount: 1,
      emit: () => {},
      resultBudgetChars: 10_000,
    };

    const [refused] = await tools.executeParallel(
      [{ toolCallId: 'c1', name: 'cached_lookup', args: {} }],
      { ...base, abortSignal: aborted.signal },
    );
    expect(executions).toBe(0);
    expect(refused?.result).toEqual({
      ok: false,
      error: ABORTED_TOOL_RESULT,
      code: 'execution_failed',
    });

    // The refusal is not a result of the tool, so it must not poison the cache.
    const [fresh] = await tools.executeParallel(
      [{ toolCallId: 'c2', name: 'cached_lookup', args: {} }],
      { ...base, abortSignal: new AbortController().signal },
    );
    expect(executions).toBe(1);
    expect(fresh?.result).toEqual({ ok: true, value: 'fresh' });
  });
});
