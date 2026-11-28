import {
  AgentLoop,
  checkTurnBudgets,
  createTurnBudgetCounters,
  DefaultHookRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
  makeTestToolContext,
  ScriptToolBridge,
} from '@ethosagent/core';
import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Tool,
  ToolContext,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { createInitiativeToolGate, runToolNames } from '../index';

const ALLOWED: ReadonlySet<string> = new Set(runToolNames(['web_search']));

function spyTool(name: string, toolset: string): { tool: Tool; ran: () => number } {
  let n = 0;
  return {
    ran: () => n,
    tool: {
      name,
      description: `${name} stub`,
      schema: { type: 'object' },
      toolset,
      capabilities: {},
      execute: async () => {
        n++;
        return { ok: true, value: `${name}:ran` };
      },
    },
  };
}

/** Scripted LLM: one tool_use of `toolName`, then a plain text end_turn. */
function oneToolLLM(toolName: string): LLMProvider {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls > 1) {
        yield { type: 'text_delta', text: 'finished' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      yield { type: 'tool_use_start', toolCallId: 'call-1', toolName };
      yield { type: 'tool_use_delta', toolCallId: 'call-1', partialJson: '{}' };
      yield { type: 'tool_use_end', toolCallId: 'call-1', inputJson: '{}' };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function runOnce(toolName: string, tool: Tool) {
  const tools = new DefaultToolRegistry();
  tools.register(tool);
  const hooks = new DefaultHookRegistry();
  hooks.registerModifying('before_tool_call', createInitiativeToolGate(ALLOWED));
  const session = new InMemorySessionStore();
  const loop = new AgentLoop({
    llm: oneToolLLM(toolName),
    tools,
    hooks,
    session,
    safety: createTestSafety(),
  });
  const events: AgentEvent[] = [];
  for await (const e of loop.run('go', { sessionKey: 'cli:initiative', roomAudience: 'private' })) {
    events.push(e);
  }
  const s = await session.getSessionByKey('cli:initiative');
  const messages = s ? await session.getMessages(s.id) : [];
  return { events, messages };
}

describe('L4 per-call gate', () => {
  it('R3 blocked call persists a tool_result', async () => {
    const { tool, ran } = spyTool('memory_write', 'memory');
    const { events, messages } = await runOnce('memory_write', tool);
    expect(ran()).toBe(0);
    const end = events.find((e) => e.type === 'tool_end');
    expect(end).toMatchObject({ toolName: 'memory_write', ok: false });
    const row = messages.find((m) => m.role === 'tool_result');
    expect(row?.isError).toBe(true);
    expect(row?.content).toContain('memory_write');
    expect(row?.content).toContain('initiative');
  });

  it('allowed call runs', async () => {
    const { tool, ran } = spyTool('web_search', 'web');
    const { messages } = await runOnce('web_search', tool);
    expect(ran()).toBe(1);
    expect(messages.find((m) => m.role === 'tool_result')?.isError).not.toBe(true);
  });

  it('script bridge path is gated too', async () => {
    const tools = new DefaultToolRegistry();
    const run = spyTool('run_code', 'code');
    const blocked = spyTool('memory_write', 'memory');
    const allowed = spyTool('web_search', 'web');
    for (const t of [run.tool, blocked.tool, allowed.tool]) tools.register(t);
    const hooks = new DefaultHookRegistry();
    hooks.registerModifying('before_tool_call', createInitiativeToolGate(ALLOWED));
    const counters = createTurnBudgetCounters();
    const bridge = new ScriptToolBridge({
      tools,
      hooks,
      sessionId: 's',
      traceId: undefined,
      allowedTools: undefined,
      allowedPlugins: [],
      filterOpts: {},
      redaction: createTestSafety().redaction,
      personality: { id: 'default', name: 'Default' },
      downgrade: {
        state: { value: 0 },
        enabled: false,
        tools: new Set(),
        turns: 0,
        rejectionMessage: '',
      },
      watcherTap: { observe: () => {}, getHalt: () => null },
      counters,
      checkBudgets: () =>
        checkTurnBudgets(
          counters.totalToolCalls,
          1000,
          counters.toolNameCounts,
          1000,
          counters.identicalStreak,
          1000,
        ),
    });
    const ctx: ToolContext = makeTestToolContext();
    const exec = bridge.bind(() => ctx).startExecution();

    const denied = await exec.call('memory_write', {});
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('initiative');
    expect(blocked.ran()).toBe(0);

    const ok = await exec.call('web_search', {});
    expect(ok.ok).toBe(true);
    expect(allowed.ran()).toBe(1);
  });
});
