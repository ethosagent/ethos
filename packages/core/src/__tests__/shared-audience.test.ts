// plan personality-memory-boundary-and-self-amendment, G1 (step 1a) — a turn
// whose `RunOptions.roomAudience` is `'shared'` touches no private memory.
//
// Every assertion is on the thing that would leak, not on a rendering of it:
// provider CALLS (not prompt text), tool DEFINITIONS the LLM receives and tool
// EXECUTIONS (not a flag), the persisted session METADATA (not a return value).
// Enforcers: `resolveTurnAudience` / `sharedStampFor` /
// `withSharedAudienceExclusions` (packages/core/src/agent-loop/audience.ts),
// called from `setupTurn` (stages/turn-setup.ts) and read by `assembleContext`
// (stages/context-assembly.ts).

import type {
  CompletionChunk,
  ContextInjector,
  LLMProvider,
  MemoryEntry,
  MemoryProvider,
  MemorySnapshot,
  Message,
  PromptContext,
  Tool,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import {
  memoryFlushForbidden,
  ROOM_AUDIENCE_METADATA_KEY,
  resolveTurnAudience,
  SHARED_AUDIENCE_EXCLUDED_TOOLS,
  sharedStampFor,
  withSharedAudienceExclusions,
} from '../agent-loop/audience';
import { persistLoaded } from '../agent-loop/stages/tool-search';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

const MEMORY_CONTENT = 'canary: interview at ACME';
const USER_CONTENT = 'The user prefers terse answers.';
const SEARCH_CONTENT = 'Semantic hit that should never be reached.';

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

interface Call {
  system: string;
  tools: string[];
}

/**
 * Records every call's system prompt and tool names. When `attempt` is set the
 * first call asks for that tool, so execution-time refusal is observable.
 */
function recordingLLM(calls: Call[], attempt?: string): LLMProvider {
  let n = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _m: Message[],
      tools: ToolDefinitionLite[],
      opts?: { system?: string },
    ): AsyncIterable<CompletionChunk> {
      calls.push({ system: opts?.system ?? '', tools: tools.map((t) => t.name) });
      if (attempt && n++ === 0) {
        yield { type: 'tool_use_start', toolCallId: 'c1', toolName: attempt };
        yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function spyMemory(prefetchReturns: MemorySnapshot | null): MemoryProvider & {
  calls: { prefetch: number; read: number; search: number };
} {
  const calls = { prefetch: 0, read: 0, search: 0 };
  return {
    calls,
    async prefetch() {
      calls.prefetch++;
      return prefetchReturns;
    },
    async read(key: string): Promise<MemoryEntry | null> {
      calls.read++;
      return key === 'USER.md' ? { key, content: USER_CONTENT } : null;
    },
    async search() {
      calls.search++;
      return [{ key: 'NOTE.md', content: SEARCH_CONTENT }];
    },
    async sync() {},
    async list() {
      return [];
    },
  };
}

function personalities(toolset?: string[]) {
  const reg = new DefaultPersonalityRegistry();
  vi.spyOn(reg, 'getDefault').mockReturnValue({
    id: 'lean',
    name: 'Lean',
    ...(toolset ? { toolset } : {}),
  });
  return reg;
}

function tool(name: string, runs: string[], extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: name,
    toolset: 'test',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute() {
      runs.push(name);
      return { ok: true, value: 'ok' };
    },
    ...extra,
  };
}

describe('audience module (unit)', () => {
  it('resolveTurnAudience: shared if the caller says so OR the session is stamped', () => {
    expect(resolveTurnAudience(undefined, undefined)).toBe('private');
    expect(resolveTurnAudience('private', undefined)).toBe('private');
    expect(resolveTurnAudience('shared', undefined)).toBe('shared');
    // Only narrows: a caller asking for private cannot unstamp a shared session.
    expect(resolveTurnAudience('private', { [ROOM_AUDIENCE_METADATA_KEY]: 'shared' })).toBe(
      'shared',
    );
    expect(resolveTurnAudience(undefined, { [ROOM_AUDIENCE_METADATA_KEY]: 'private' })).toBe(
      'private',
    );
  });

  it('sharedStampFor merges, writes only for an unstamped shared turn, never writes private', () => {
    expect(sharedStampFor('private', { a: 1 })).toBeUndefined();
    expect(sharedStampFor('shared', { [ROOM_AUDIENCE_METADATA_KEY]: 'shared' })).toBeUndefined();
    expect(sharedStampFor('shared', { loadedTools: ['x'] })).toEqual({
      loadedTools: ['x'],
      [ROOM_AUDIENCE_METADATA_KEY]: 'shared',
    });
  });

  it('withSharedAudienceExclusions unions on shared and returns the input untouched on private', () => {
    const surface = ['emit_card'];
    expect(withSharedAudienceExclusions('private', surface)).toBe(surface);
    expect(withSharedAudienceExclusions('private', undefined)).toBeUndefined();
    const shared = withSharedAudienceExclusions('shared', surface) ?? [];
    expect(shared).toContain('emit_card');
    for (const name of SHARED_AUDIENCE_EXCLUDED_TOOLS) expect(shared).toContain(name);
  });

  it('the exclusion list is the plan’s final list; session_search stays available', () => {
    expect([...SHARED_AUDIENCE_EXCLUDED_TOOLS].sort()).toEqual(
      [
        'memory_read',
        'memory_write',
        'session_list_by_date',
        'get_session_events',
        'get_observability',
        'team_memory_read',
        'team_memory_write',
        'team_memory_search',
        'meet_join',
        'terminal',
        'run_code',
        'process_start',
        'process_list',
        'process_logs',
        'process_stop',
        'process_wait',
        'process_watch',
        'dashboard_add_panel',
        'dashboard_update_panel',
        'route_to_agent',
        'skills_pending_list',
        'skills_pending_view',
        'skills_pending_approve',
        'skills_pending_reject',
      ].sort(),
    );
    expect(SHARED_AUDIENCE_EXCLUDED_TOOLS).not.toContain('session_search');
  });

  it('memoryFlushForbidden: shared, or memory_write excluded', () => {
    expect(memoryFlushForbidden('shared', undefined)).toBe(true);
    expect(memoryFlushForbidden('private', ['memory_write'])).toBe(true);
    expect(memoryFlushForbidden(undefined, ['emit_card'])).toBe(false);
    expect(memoryFlushForbidden('private', undefined)).toBe(false);
  });
});

describe('G1-1 — a shared turn makes zero private-memory provider calls', () => {
  it('no prefetch, no search fallback, no user read, and no memory section', async () => {
    const memory = spyMemory(null); // null prefetch would normally trigger search
    const calls: Call[] = [];
    const loop = new AgentLoop({
      llm: recordingLLM(calls),
      personalities: personalities([]),
      safety: createTestSafety(),
      memory,
    });

    await drain(loop.run('hello', { userId: 'u1', roomAudience: 'shared' }));

    expect(memory.calls).toEqual({ prefetch: 0, read: 0, search: 0 });
    expect(calls[0]?.system).not.toContain(SEARCH_CONTENT);
    expect(calls[0]?.system).not.toContain(USER_CONTENT);
  });

  it('absent roomAudience keeps today’s behaviour (private): prefetch and user read run', async () => {
    const memory = spyMemory({ entries: [{ key: 'MEMORY.md', content: MEMORY_CONTENT }] });
    const calls: Call[] = [];
    const loop = new AgentLoop({
      llm: recordingLLM(calls),
      personalities: personalities([]),
      safety: createTestSafety(),
      memory,
    });

    await drain(loop.run('hello', { userId: 'u1' }));

    expect(memory.calls.prefetch).toBe(1);
    expect(memory.calls.read).toBe(1);
    expect(calls[0]?.system).toContain(MEMORY_CONTENT);
  });
});

describe('G1-4 — PromptContext.isDm follows the audience', () => {
  function isDmSpy(seen: boolean[]): ContextInjector {
    return {
      id: 'isdm-spy',
      priority: 1,
      async inject(ctx: PromptContext) {
        seen.push(ctx.isDm);
        return null;
      },
    };
  }

  it('false on a shared turn, true on a private one', async () => {
    const seen: boolean[] = [];
    const loop = new AgentLoop({
      llm: recordingLLM([]),
      personalities: personalities([]),
      safety: createTestSafety(),
      injectors: [isDmSpy(seen)],
    });

    await drain(loop.run('a', { sessionKey: 'telegram:bot:-100', roomAudience: 'shared' }));
    await drain(loop.run('b', { sessionKey: 'cli:here' }));

    expect(seen).toEqual([false, true]);
  });
});

describe('G1-2 — excluded tools are neither seen nor executed on a shared turn', () => {
  it('memory_write is absent from definitions even with alwaysInclude, and refused if called', async () => {
    const runs: string[] = [];
    const tools = new DefaultToolRegistry();
    tools.register(tool('memory_write', runs, { alwaysInclude: true }));
    tools.register(tool('memory_read', runs));
    tools.register(tool('session_search', runs));
    const calls: Call[] = [];
    const loop = new AgentLoop({
      llm: recordingLLM(calls, 'memory_write'),
      personalities: personalities(['memory_read', 'session_search']),
      tools,
      safety: createTestSafety(),
    });

    const events = await drain(loop.run('remember this', { roomAudience: 'shared' }));

    expect(calls[0]?.tools).not.toContain('memory_write');
    expect(calls[0]?.tools).not.toContain('memory_read');
    expect(calls[0]?.tools).toContain('session_search');
    expect(runs).toEqual([]);
    const end = events.find((e) => e.type === 'tool_end' && e.toolName === 'memory_write');
    expect(end?.type === 'tool_end' && end.ok).toBe(false);
  });

  it('an excluded plugin tool the plugin allowlist admits is still excluded', async () => {
    const runs: string[] = [];
    const tools = new DefaultToolRegistry();
    tools.register(tool('memory_read', runs), { pluginId: 'mem-plugin' });
    const calls: Call[] = [];
    const reg = new DefaultPersonalityRegistry();
    vi.spyOn(reg, 'getDefault').mockReturnValue({
      id: 'lean',
      name: 'Lean',
      plugins: ['mem-plugin'],
    });
    const loop = new AgentLoop({
      llm: recordingLLM(calls, 'memory_read'),
      personalities: reg,
      tools,
      safety: createTestSafety(),
    });

    await drain(loop.run('what do you remember', { roomAudience: 'shared' }));

    expect(calls[0]?.tools).not.toContain('memory_read');
    expect(runs).toEqual([]);
  });

  it('a private turn still sees and runs the same tool', async () => {
    const runs: string[] = [];
    const tools = new DefaultToolRegistry();
    tools.register(tool('memory_read', runs));
    const calls: Call[] = [];
    const loop = new AgentLoop({
      llm: recordingLLM(calls, 'memory_read'),
      personalities: personalities(['memory_read']),
      tools,
      safety: createTestSafety(),
    });

    await drain(loop.run('what do you remember'));

    expect(calls[0]?.tools).toContain('memory_read');
    expect(runs).toEqual(['memory_read']);
  });
});

describe('G1-7 — a session that ran a shared turn stays shared', () => {
  it('stamps the session, and a later turn with no roomAudience is still shared', async () => {
    const session = new InMemorySessionStore();
    const memory = spyMemory({ entries: [{ key: 'MEMORY.md', content: MEMORY_CONTENT }] });
    const calls: Call[] = [];
    const loop = new AgentLoop({
      llm: recordingLLM(calls),
      personalities: personalities([]),
      safety: createTestSafety(),
      memory,
      session,
    });

    await drain(loop.run('first', { sessionKey: 'web:s1', roomAudience: 'shared' }));
    const stamped = await session.getSessionByKey('web:s1');
    expect(stamped?.metadata?.[ROOM_AUDIENCE_METADATA_KEY]).toBe('shared');

    // A caller that says private (or nothing) cannot flip it back.
    await drain(loop.run('second', { sessionKey: 'web:s1', roomAudience: 'private' }));
    await drain(loop.run('third', { sessionKey: 'web:s1' }));

    expect(memory.calls.prefetch).toBe(0);
    expect(calls.every((c) => !c.system.includes(MEMORY_CONTENT))).toBe(true);
    const after = await session.getSessionByKey('web:s1');
    expect(after?.metadata?.[ROOM_AUDIENCE_METADATA_KEY]).toBe('shared');
  });

  it('the stamp merges into existing metadata instead of replacing it', async () => {
    const session = new InMemorySessionStore();
    const created = await session.createSession({
      key: 'telegram:bot:-100',
      platform: 'telegram',
      model: 'mock-model',
      provider: 'mock',
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
    await session.updateSession(created.id, { metadata: { loadedTools: ['web_search'] } });
    const loop = new AgentLoop({
      llm: recordingLLM([]),
      personalities: personalities([]),
      safety: createTestSafety(),
      session,
    });

    await drain(loop.run('hi', { sessionKey: 'telegram:bot:-100', roomAudience: 'shared' }));

    const after = await session.getSession(created.id);
    expect(after?.metadata).toEqual({
      loadedTools: ['web_search'],
      [ROOM_AUDIENCE_METADATA_KEY]: 'shared',
    });
  });

  it('a private turn never writes the stamp', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: recordingLLM([]),
      personalities: personalities([]),
      safety: createTestSafety(),
      session,
    });

    await drain(loop.run('hi', { sessionKey: 'cli:p', roomAudience: 'private' }));

    const s = await session.getSessionByKey('cli:p');
    expect(s?.metadata?.[ROOM_AUDIENCE_METADATA_KEY]).toBeUndefined();
  });

  it('persistLoaded (the other metadata writer in a turn) preserves the stamp', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: recordingLLM([]),
      personalities: personalities([]),
      safety: createTestSafety(),
      session,
    });
    await drain(loop.run('hi', { sessionKey: 'cli:tl', roomAudience: 'shared' }));
    const s = await session.getSessionByKey('cli:tl');
    if (!s) throw new Error('session missing');

    await persistLoaded(session, s.id, ['web_search']);

    const after = await session.getSession(s.id);
    expect(after?.metadata?.[ROOM_AUDIENCE_METADATA_KEY]).toBe('shared');
    expect(after?.metadata?.loadedTools).toEqual(['web_search']);
  });
});
