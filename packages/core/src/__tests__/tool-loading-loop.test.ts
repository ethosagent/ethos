// reach-and-containment Part 1 (C2–C4, C6) — on-demand tool loading through
// a REAL AgentLoop with a scripted LLM. Asserts on the tools array the provider
// actually receives, and on the allowlist boundary staying where it was:
// `DefaultToolRegistry.executeParallel`.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  PersonalityConfig,
  Tool,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { MAX_LOADED_TOOLS, TOOL_SEARCH_NAME } from '../agent-loop/tool-loading';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

interface ScriptStep {
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  text?: string;
}

interface Captured {
  tools: ToolDefinitionLite[];
  messages: Message[];
}

function scriptedLLM(steps: ScriptStep[], captured: Captured[]): LLMProvider {
  let i = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      messages: Message[],
      tools: ToolDefinitionLite[],
      _opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      captured.push({ tools: structuredClone(tools), messages: structuredClone(messages) });
      const step = steps[i++] ?? { text: 'done' };
      for (const tc of step.toolCalls ?? []) {
        yield { type: 'tool_use_start', toolCallId: tc.id, toolName: tc.name };
        yield { type: 'tool_use_end', toolCallId: tc.id, inputJson: JSON.stringify(tc.input) };
      }
      if (step.toolCalls?.length) {
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: step.text ?? 'done' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function tool(name: string, description: string, ran?: string[]): Tool {
  return {
    name,
    description,
    schema: { type: 'object', properties: { q: { type: 'string' } } },
    capabilities: {},
    execute: async () => {
      ran?.push(name);
      return { ok: true, value: `${name} ran` };
    },
  };
}

const PERSONALITY: PersonalityConfig = {
  id: 'lean',
  name: 'Lean',
  toolset: ['alpha', 'beta'],
  mcp_servers: ['github', 'linear'],
};

function makeRegistry(ran?: string[], extraMcp = 0): DefaultToolRegistry {
  const r = new DefaultToolRegistry();
  r.register(tool('alpha', 'Alpha built-in', ran));
  r.register(tool('beta', 'Beta built-in', ran));
  r.register(tool('gamma', 'Gamma built-in outside the toolset (github issue)', ran));
  r.register(tool('mcp__github__list_issues', 'List GitHub issues for a repo', ran));
  r.register(tool('mcp__github__close_issue', 'Close a GitHub issue', ran));
  r.register(tool('mcp__linear__list', 'List Linear tickets', ran));
  r.register(tool('mcp__secret__dump', 'Dump github issue secrets (server not allowed)', ran));
  for (let n = 0; n < extraMcp; n++) {
    r.register(tool(`mcp__github__extra_${n}`, `Extra github helper ${n}`, ran));
  }
  return r;
}

function makeLoop(opts: {
  steps: ScriptStep[];
  captured: Captured[];
  tools: DefaultToolRegistry;
  session?: InMemorySessionStore;
  loading?: boolean;
}): AgentLoop {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue(PERSONALITY);
  return new AgentLoop({
    llm: scriptedLLM(opts.steps, opts.captured),
    tools: opts.tools,
    personalities,
    session: opts.session ?? new InMemorySessionStore(),
    safety: createTestSafety(),
    ...(opts.loading === false ? {} : { toolLoading: () => true }),
  });
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const names = (defs: ToolDefinitionLite[] | undefined) => (defs ?? []).map((d) => d.name);

function toolResults(messages: Message[]): Array<{ id: string; content: string }> {
  const out: Array<{ id: string; content: string }> = [];
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') out.push({ id: b.tool_use_id, content: b.content });
    }
  }
  return out;
}

describe('on-demand tool loading — real AgentLoop', () => {
  it('step 1 carries pinned + tool_search; a search appends the hit at the END for step 2', async () => {
    const captured: Captured[] = [];
    const session = new InMemorySessionStore();
    const loop = makeLoop({
      steps: [
        { toolCalls: [{ id: 's1', name: TOOL_SEARCH_NAME, input: { query: 'github issue' } }] },
        { text: 'found it' },
      ],
      captured,
      tools: makeRegistry(),
      session,
    });
    await collect(loop.run('find the issues tool', { sessionKey: 'k' }));

    expect(captured).toHaveLength(2);
    const step1 = captured[0]?.tools ?? [];
    const step2 = captured[1]?.tools ?? [];
    expect(names(step1)).toEqual(['alpha', 'beta', TOOL_SEARCH_NAME]);
    expect(names(step2)).toEqual([
      'alpha',
      'beta',
      TOOL_SEARCH_NAME,
      'mcp__github__list_issues',
      'mcp__github__close_issue',
    ]);
    // D1-2 — step 2's array starts byte-identically with step 1's.
    expect(JSON.stringify(step2.slice(0, step1.length))).toBe(JSON.stringify(step1));

    // C6 — persisted in load order.
    const stored = await session.getSessionByKey('k');
    expect(stored?.metadata?.loadedTools).toEqual([
      'mcp__github__list_issues',
      'mcp__github__close_issue',
    ]);
  });

  it('an allowed-but-unloaded tool called directly runs and is loaded for the next step (D1-1)', async () => {
    const captured: Captured[] = [];
    const ran: string[] = [];
    const loop = makeLoop({
      steps: [{ toolCalls: [{ id: 'd1', name: 'mcp__linear__list', input: {} }] }, { text: 'ok' }],
      captured,
      tools: makeRegistry(ran),
    });
    const events = await collect(loop.run('list linear'));
    expect(ran).toEqual(['mcp__linear__list']);
    const end = events.find((e) => e.type === 'tool_end');
    expect(end?.type === 'tool_end' && end.ok).toBe(true);
    expect(names(captured[0]?.tools)).not.toContain('mcp__linear__list');
    expect(names(captured[1]?.tools).at(-1)).toBe('mcp__linear__list');
  });

  it('a tool outside the allowlist is refused by executeParallel and never found by tool_search', async () => {
    const captured: Captured[] = [];
    const ran: string[] = [];
    const tools = makeRegistry(ran);
    const exec = vi.spyOn(tools, 'executeParallel');
    const loop = makeLoop({
      steps: [
        {
          toolCalls: [
            { id: 'x1', name: 'mcp__secret__dump', input: {} },
            { id: 'x2', name: 'gamma', input: {} },
            { id: 's1', name: TOOL_SEARCH_NAME, input: { query: 'mcp__secret__dump', limit: 10 } },
            { id: 's2', name: TOOL_SEARCH_NAME, input: { query: 'gamma github issue secrets' } },
          ],
        },
        { text: 'ok' },
      ],
      captured,
      tools,
    });
    await collect(loop.run('try everything'));

    expect(ran).toEqual([]);
    const results = await exec.mock.results[0]?.value;
    for (const r of results ?? []) {
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.code).toBe('not_available');
    }
    expect((results ?? []).map((r: { name: string }) => r.name).sort()).toEqual([
      'gamma',
      'mcp__secret__dump',
    ]);

    const byId = new Map(toolResults(captured[1]?.messages ?? []).map((r) => [r.id, r.content]));
    expect(byId.get('s1')).not.toContain('mcp__secret__dump');
    expect(byId.get('s2')).not.toContain('mcp__secret__dump');
    expect(byId.get('s2')).not.toContain('- gamma');
    // Neither refused tool was loaded.
    expect(names(captured[1]?.tools)).not.toContain('gamma');
    expect(names(captured[1]?.tools)).not.toContain('mcp__secret__dump');
  });

  it('every tool_search tool_use gets exactly one tool_result', async () => {
    const captured: Captured[] = [];
    const session = new InMemorySessionStore();
    const loop = makeLoop({
      steps: [
        {
          toolCalls: [
            { id: 's1', name: TOOL_SEARCH_NAME, input: { query: 'linear' } },
            { id: 'a1', name: 'alpha', input: {} },
            { id: 's2', name: TOOL_SEARCH_NAME, input: { query: 'nothing matches this' } },
          ],
        },
        { text: 'ok' },
      ],
      captured,
      tools: makeRegistry(),
      session,
    });
    await collect(loop.run('go', { sessionKey: 'pair' }));

    const results = toolResults(captured[1]?.messages ?? []);
    for (const id of ['s1', 'a1', 's2']) {
      expect(results.filter((r) => r.id === id)).toHaveLength(1);
    }
    expect(results.find((r) => r.id === 's2')?.content).toContain('No tools matched');

    // Persisted too, so a reload replays a paired history.
    const stored = await session.getSessionByKey('pair');
    const rows = await session.getMessages(stored?.id ?? '', { limit: 50 });
    const persisted = rows.filter((m) => m.role === 'tool_result').map((m) => m.toolCallId);
    expect(persisted.sort()).toEqual(['a1', 's1', 's2']);
  });

  it('at the 32-tool cap a search returns hits without appending them (D1-2)', async () => {
    const captured: Captured[] = [];
    const session = new InMemorySessionStore();
    const tools = makeRegistry(undefined, 40);
    const preloaded = Array.from({ length: MAX_LOADED_TOOLS }, (_, n) => `mcp__github__extra_${n}`);
    const created = await session.createSession({
      key: 'cap',
      platform: 'cli',
      model: 'mock-model',
      provider: 'scripted',
      workingDir: '/tmp',
      metadata: { keep: 'me', loadedTools: preloaded },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });
    const loop = makeLoop({
      steps: [
        { toolCalls: [{ id: 's1', name: TOOL_SEARCH_NAME, input: { query: 'linear tickets' } }] },
        { text: 'ok' },
      ],
      captured,
      tools,
      session,
    });
    await collect(loop.run('search', { sessionKey: 'cap' }));

    const content = toolResults(captured[1]?.messages ?? [])[0]?.content ?? '';
    expect(content).toContain('mcp__linear__list');
    expect(content).toContain('call them directly');
    expect(names(captured[1]?.tools)).not.toContain('mcp__linear__list');
    expect(JSON.stringify(captured[1]?.tools)).toBe(JSON.stringify(captured[0]?.tools));
    const stored = await session.getSession(created.id);
    expect(stored?.metadata?.loadedTools).toEqual(preloaded);
    expect(stored?.metadata?.keep).toBe('me');
  });

  it('with no resolver the request bytes equal toDefinitions — the default-preserving law', async () => {
    const captured: Captured[] = [];
    const tools = makeRegistry();
    const loop = makeLoop({
      steps: [{ toolCalls: [{ id: 'a1', name: 'alpha', input: {} }] }, { text: 'ok' }],
      captured,
      tools,
      loading: false,
    });
    await collect(loop.run('hi'));
    const expected = JSON.stringify(
      tools.toDefinitions(PERSONALITY.toolset, {
        allowedMcpServers: ['github', 'linear'],
        allowedPlugins: [],
      }),
    );
    expect(captured).toHaveLength(2);
    for (const c of captured) expect(JSON.stringify(c.tools)).toBe(expected);
    expect(names(captured[0]?.tools)).not.toContain(TOOL_SEARCH_NAME);
  });

  it('a resolver that says no is byte-identical to no resolver', async () => {
    const run = async (resolver: boolean | undefined) => {
      const captured: Captured[] = [];
      const personalities = new DefaultPersonalityRegistry();
      vi.spyOn(personalities, 'getDefault').mockReturnValue(PERSONALITY);
      const loop = new AgentLoop({
        llm: scriptedLLM([{ text: 'ok' }], captured),
        tools: makeRegistry(),
        personalities,
        safety: createTestSafety(),
        ...(resolver === undefined ? {} : { toolLoading: () => resolver }),
      });
      await collect(loop.run('hi'));
      return JSON.stringify(captured.map((c) => c.tools));
    };
    expect(await run(false)).toBe(await run(undefined));
  });
});
