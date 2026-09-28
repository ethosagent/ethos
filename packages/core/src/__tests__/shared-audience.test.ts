// plan personality-memory-boundary-and-self-amendment, G1 (step 1a) — a turn
// whose `RunOptions.roomAudience` is `'shared'` touches no private memory.
//
// Every assertion is on the thing that would leak, not on a rendering of it:
// provider CALLS (not prompt text), tool DEFINITIONS the LLM receives and tool
// EXECUTIONS (not a flag), the persisted session METADATA (not a return value).
// Enforcers: `resolveTurnAudience` / `sessionAudienceStampFor` /
// `withSharedAudienceExclusions` (packages/core/src/agent-loop/audience.ts;
// `sessionAudienceStampFor` in packages/core/src/chat-audience.ts),
// called from `setupTurn` (stages/turn-setup.ts) and read by `assembleContext`
// (stages/context-assembly.ts).

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsAttachmentCache, FsStorage, InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  ContextInjector,
  LLMProvider,
  MemoryEntry,
  MemoryProvider,
  MemorySnapshot,
  Message,
  PersonalityConfig,
  PromptContext,
  Tool,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import {
  memoryFlushForbidden,
  ROOM_AUDIENCE_METADATA_KEY,
  resolveTurnAudience,
  SHARED_AUDIENCE_EXCLUDED_TOOLS,
  sharedTurnDenyFor,
  withPersonalityMemoryWithheld,
  withSharedAudienceExclusions,
} from '../agent-loop/audience';
import { persistLoaded } from '../agent-loop/stages/tool-search';
import { type CapabilityBackends, resolveCapabilities } from '../capability-resolver';
import { PERSONALITY_MEMORY_WITHHELD_METADATA_KEY, turnWasShared } from '../chat-audience';
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

function personalities(toolset?: string[], extra: Partial<PersonalityConfig> = {}) {
  const reg = new DefaultPersonalityRegistry();
  vi.spyOn(reg, 'getDefault').mockReturnValue({
    id: 'lean',
    name: 'Lean',
    ...(toolset ? { toolset } : {}),
    ...extra,
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
        'run_tests',
        'lint',
        'process_start',
        'process_list',
        'process_logs',
        'process_stop',
        'process_wait',
        'process_watch',
        'dashboard_add_panel',
        'dashboard_update_panel',
        'dashboard_import',
        'dashboard_set_params',
        'dashboard_export',
        'route_to_agent',
        'dispatch_team',
        'broadcast_to_agents',
        'skills_pending_list',
        'skills_pending_view',
        'skills_pending_approve',
        'skills_pending_reject',
      ].sort(),
    );
    expect(SHARED_AUDIENCE_EXCLUDED_TOOLS).not.toContain('session_search');
  });

  it('sharedTurnDenyFor: a predicate only on a shared turn; absent roots fail closed on ~/.ethos', () => {
    expect(sharedTurnDenyFor('private', { stateDirs: ['/s'] }, 'p')).toBeUndefined();
    expect(sharedTurnDenyFor(undefined, { stateDirs: ['/s'] }, 'p')).toBeUndefined();
    const deny = sharedTurnDenyFor('shared', { stateDirs: ['/s'] }, 'p');
    expect(deny?.('/s/personalities/p/MEMORY.md', 'access')).toBe(true);
    expect(deny?.('/s/personalities/p/files/a.png', 'access')).toBe(false);
    const fallback = sharedTurnDenyFor('shared', undefined, 'p');
    expect(fallback?.(join(homedir(), '.ethos', 'users', 'u1', 'USER.md'), 'access')).toBe(true);
  });

  // Verification round A3 — one state-dir set: wired roots, `~/.ethos`,
  // `ETHOS_STATE_DIR`, and the realpath of each (a symlinked state dir).
  it('sharedTurnDenyFor: always adds ETHOS_STATE_DIR, ~/.ethos and realpaths', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'ethos-audience-roots-')));
    try {
      const real = join(tmp, 'real-state');
      const link = join(tmp, 'linked-state');
      await mkdir(real);
      await symlink(real, link);
      vi.stubEnv('ETHOS_STATE_DIR', link);
      const deny = sharedTurnDenyFor('shared', { stateDirs: ['/s'] }, 'p');
      expect(deny?.(join(link, 'users', 'u1', 'USER.md'), 'access')).toBe(true);
      expect(deny?.(join(real, 'personalities', 'p', 'MEMORY.md'), 'access')).toBe(true);
      expect(deny?.(join(homedir(), '.ethos', 'MEMORY.md'), 'access')).toBe(true);
      expect(deny?.('/s/personalities/p/memory.md', 'access')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await rm(tmp, { recursive: true, force: true });
    }
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

describe('D8 — a non-owner DM withholds personality memory but keeps the sender’s own', () => {
  it('withPersonalityMemoryWithheld narrows a private turn only when asked', () => {
    expect(withPersonalityMemoryWithheld('private', true)).toEqual({
      roomAudience: 'shared',
      userMemoryOnly: true,
    });
    expect(withPersonalityMemoryWithheld('private', undefined)).toEqual({
      roomAudience: 'private',
      userMemoryOnly: false,
    });
    // Already shared: nothing to keep, the user read stays off too.
    expect(withPersonalityMemoryWithheld('shared', true)).toEqual({
      roomAudience: 'shared',
      userMemoryOnly: false,
    });
  });

  it('no personality prefetch or search, the user read still runs, memory tools excluded, never stamped', async () => {
    const memory = spyMemory({ entries: [{ key: 'MEMORY.md', content: MEMORY_CONTENT }] });
    const runs: string[] = [];
    const tools = new DefaultToolRegistry();
    tools.register(tool('memory_read', runs));
    tools.register(tool('session_search', runs));
    const calls: Call[] = [];
    const session = new InMemorySessionStore();
    const seen: boolean[] = [];
    const loop = new AgentLoop({
      llm: recordingLLM(calls, 'memory_read'),
      personalities: personalities(['memory_read', 'session_search']),
      tools,
      session,
      safety: createTestSafety(),
      memory,
      injectors: [
        {
          id: 'isdm-spy',
          priority: 1,
          async inject(ctx: PromptContext) {
            seen.push(ctx.isDm);
            return null;
          },
        },
      ],
    });

    await drain(
      loop.run('hello', {
        sessionKey: 'telegram:bot:42',
        userId: 'stranger',
        roomAudience: 'private',
        skipPersonalityMemory: true,
      }),
    );

    expect(memory.calls).toEqual({ prefetch: 0, read: 1, search: 0 });
    expect(calls[0]?.system).toContain(USER_CONTENT);
    expect(calls[0]?.system).not.toContain(MEMORY_CONTENT);
    expect(calls[0]?.tools).not.toContain('memory_read');
    expect(calls[0]?.tools).toContain('session_search');
    expect(runs).toEqual([]);
    expect(seen).toEqual([false]);
    // The narrowing is not persisted as a stamp: the stranger's session is not
    // shared. Only the learners' withheld marker is (verification round B2).
    const stored = await session.getSessionByKey('telegram:bot:42');
    expect(stored?.metadata?.[ROOM_AUDIENCE_METADATA_KEY]).toBeUndefined();
    expect(stored?.metadata?.[PERSONALITY_MEMORY_WITHHELD_METADATA_KEY]).toBe(true);
    expect(stored && turnWasShared(stored)).toBe(true);

    // The marker never narrows a later turn: without the D8 flag the same
    // session runs private and reads personality memory again.
    await drain(loop.run('again', { sessionKey: 'telegram:bot:42', roomAudience: 'private' }));
    expect(memory.calls.prefetch).toBe(1);
  });
});

describe('verification round B3/B15 — the session audience a turn records and falls back to', () => {
  it('a private turn on an unstamped Discord DM records the judged private stamp', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: recordingLLM([]),
      personalities: personalities([]),
      session,
      safety: createTestSafety(),
    });
    const key = 'discord:bot:555';
    await drain(loop.run('hi', { sessionKey: key, roomAudience: 'private', judgeAudience: true }));
    const stored = await session.getSessionByKey(key);
    expect(stored?.metadata?.[ROOM_AUDIENCE_METADATA_KEY]).toBe('private');
    expect(stored && turnWasShared(stored)).toBe(false);
  });

  // Verification round E5 — only a caller that judged the room (the gateway,
  // `judgeAudience`) records the private stamp. An ACP client naming a
  // pre-upgrade group lane key with an explicit 'private' runs private for
  // that turn but leaves the key to be judged by its shape next time; ACP
  // itself now passes no audience, so the key runs shared.
  it('an explicit private without judgeAudience never writes the judged stamp', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: recordingLLM([]),
      personalities: personalities([]),
      session,
      safety: createTestSafety(),
    });
    const key = 'telegram:bot:-1002';
    await drain(loop.run('hi', { sessionKey: key, roomAudience: 'private' }));
    const stored = await session.getSessionByKey(key);
    expect(stored?.metadata?.[ROOM_AUDIENCE_METADATA_KEY]).toBeUndefined();
    expect(stored && turnWasShared(stored)).toBe(true);
  });

  it('an ACP-style caller (no audience) on a pre-upgrade group lane key runs shared', async () => {
    const session = new InMemorySessionStore();
    const memory = spyMemory({ entries: [{ key: 'MEMORY.md', content: MEMORY_CONTENT }] });
    const loop = new AgentLoop({
      llm: recordingLLM([]),
      personalities: personalities([]),
      session,
      safety: createTestSafety(),
      memory,
    });
    const key = 'discord:bot:777';
    await drain(loop.run('hi', { sessionKey: key, credentialPrompt: true }));
    expect(memory.calls.prefetch).toBe(0);
    const stored = await session.getSessionByKey(key);
    expect(stored?.metadata?.[ROOM_AUDIENCE_METADATA_KEY]).toBe('shared');
  });

  it('a caller naming no audience runs a pre-upgrade group session shared and stamps it', async () => {
    const session = new InMemorySessionStore();
    const memory = spyMemory({ entries: [{ key: 'MEMORY.md', content: MEMORY_CONTENT }] });
    const calls: Call[] = [];
    const loop = new AgentLoop({
      llm: recordingLLM(calls),
      personalities: personalities([]),
      session,
      safety: createTestSafety(),
      memory,
    });
    // A web `chat.send` against an old unstamped Telegram group session.
    const key = 'telegram:bot:-1001';
    await drain(loop.run('hi', { sessionKey: key }));
    expect(memory.calls.prefetch).toBe(0);
    expect(calls[0]?.system).not.toContain(MEMORY_CONTENT);
    const stored = await session.getSessionByKey(key);
    expect(stored?.metadata?.[ROOM_AUDIENCE_METADATA_KEY]).toBe('shared');
  });

  it('a caller naming no audience keeps a judged-private session private', async () => {
    const session = new InMemorySessionStore();
    const memory = spyMemory({ entries: [{ key: 'MEMORY.md', content: MEMORY_CONTENT }] });
    const loop = new AgentLoop({
      llm: recordingLLM([]),
      personalities: personalities([]),
      session,
      safety: createTestSafety(),
      memory,
    });
    const key = 'discord:bot:555';
    await drain(loop.run('hi', { sessionKey: key, roomAudience: 'private', judgeAudience: true }));
    await drain(loop.run('again', { sessionKey: key }));
    expect(memory.calls.prefetch).toBe(2);
    const stored = await session.getSessionByKey(key);
    expect(stored?.metadata?.[ROOM_AUDIENCE_METADATA_KEY]).toBe('private');
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

// G1-5 — through the REAL transport: `AgentLoop.run` → `executeParallel` →
// `LocalToolTransport` → `resolveCapabilities` (ctx.scopedFs) and the turn's
// `buildScopedStorage` (ctx.storage). Never `tool.execute` directly: the
// deny must survive every hop the production path takes.
describe('G1-5 — no file tool reaches a private memory file on a shared turn', () => {
  let home: string;
  let own: string;
  let cwd: string;
  let vault: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-g15-')));
    own = join(home, 'personalities', 'lean');
    cwd = join(home, 'work');
    vault = join(home, 'vault');
    await mkdir(join(own, 'files'), { recursive: true });
    await mkdir(join(own, 'ui'), { recursive: true });
    await mkdir(join(home, 'users', 'u1'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(vault, { recursive: true });
    await writeFile(join(own, 'MEMORY.md'), MEMORY_CONTENT);
    await writeFile(join(own, 'files', 'logo.txt'), 'asset');
    await writeFile(join(own, 'ui', 'report.html'), '<p>template</p>');
    await writeFile(join(home, 'users', 'u1', 'USER.md'), USER_CONTENT);
    await writeFile(join(home, 'memory.db'), 'sqlite');
    await writeFile(join(vault, 'journal.md'), 'vault note');
    // An innocently named link in the working directory (verify item 20).
    await symlink(join(own, 'MEMORY.md'), join(cwd, 'notes.txt'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /** An LLM whose first reply calls `toolName` once per path, then ends. */
  function readingLLM(toolName: string, paths: string[]): LLMProvider {
    let n = 0;
    return {
      name: 'mock',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(): AsyncIterable<CompletionChunk> {
        if (n++ === 0) {
          for (const [i, path] of paths.entries()) {
            yield { type: 'tool_use_start', toolCallId: `c${i}`, toolName };
            yield {
              type: 'tool_use_end',
              toolCallId: `c${i}`,
              inputJson: JSON.stringify({ path }),
            };
          }
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

  type Outcome = Record<string, string>;

  function pathArgs(input: unknown): { path: string } {
    const path =
      typeof input === 'object' && input !== null && 'path' in input ? String(input.path) : '';
    return { path };
  }

  /** A file tool reading through `ctx.scopedFs` (`fs_reach: from-personality`). */
  function scopedFsReader(out: Outcome): Tool {
    return {
      name: 'read_file',
      description: 'read',
      toolset: 'file',
      capabilities: { fs_reach: { read: 'from-personality' } },
      schema: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(input, ctx) {
        const args = pathArgs(input);
        try {
          if (!ctx.scopedFs) throw new Error('no scopedFs');
          out[args.path] = await ctx.scopedFs.read(args.path);
        } catch (err) {
          out[args.path] = `refused: ${err instanceof Error ? err.message : String(err)}`;
        }
        return { ok: true, value: 'done' };
      },
    };
  }

  /** A file tool reading through the turn's scoped `ctx.storage`. */
  function storageReader(out: Outcome): Tool {
    return {
      name: 'storage_read',
      description: 'read',
      toolset: 'file',
      capabilities: {},
      schema: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(input, ctx) {
        const args = pathArgs(input);
        try {
          if (!ctx.storage) throw new Error('no storage');
          out[args.path] = (await ctx.storage.read(args.path)) ?? '(missing)';
        } catch (err) {
          out[args.path] = `refused: ${err instanceof Error ? err.message : String(err)}`;
        }
        return { ok: true, value: 'done' };
      },
    };
  }

  function loopFor(llm: LLMProvider, tools: DefaultToolRegistry): AgentLoop {
    return new AgentLoop({
      llm,
      tools,
      personalities: personalities(['read_file', 'storage_read']),
      storage: new FsStorage(),
      dataDir: home,
      privateMemoryRoots: [vault],
      safety: createTestSafety(),
      options: { workingDir: cwd },
    });
  }

  function backends(): CapabilityBackends {
    return {
      storage: new FsStorage(),
      personalityFsReach: () => ({ read: [`${own}/`, `${cwd}/`, `${vault}/`], write: [] }),
      privateMemoryRoots: { stateDirs: [home], extraRoots: [vault] },
    };
  }

  it('read_file (scopedFs) refuses MEMORY.md, a symlink to it and the vault; assets and templates still read', async () => {
    const out: Outcome = {};
    const tools = new DefaultToolRegistry(backends());
    tools.register(scopedFsReader(out));
    const paths = [
      join(own, 'MEMORY.md'),
      join(cwd, 'notes.txt'),
      join(vault, 'journal.md'),
      join(own, 'files', 'logo.txt'),
      join(own, 'ui', 'report.html'),
    ];
    await drain(
      loopFor(readingLLM('read_file', paths), tools).run('read', { roomAudience: 'shared' }),
    );

    expect(out[join(own, 'MEMORY.md')]).toMatch(/^refused: PATH_NOT_REACHABLE/);
    expect(out[join(cwd, 'notes.txt')]).toMatch(/^refused: PATH_NOT_REACHABLE/);
    expect(out[join(vault, 'journal.md')]).toMatch(/^refused: PATH_NOT_REACHABLE/);
    expect(out[join(own, 'files', 'logo.txt')]).toBe('asset');
    expect(out[join(own, 'ui', 'report.html')]).toBe('<p>template</p>');
    expect(JSON.stringify(out)).not.toContain(MEMORY_CONTENT);
  });

  it('the turn’s scoped Storage refuses MEMORY.md, USER.md under users/, memory.db, a symlink and the vault', async () => {
    const out: Outcome = {};
    const tools = new DefaultToolRegistry();
    tools.register(storageReader(out));
    // The default reach is [ownDir, skills/, cwd]; the state dir itself is the
    // cwd's parent, so read users/ and memory.db through a cwd that IS the
    // state dir to prove the deny, not the allowlist, refuses them.
    const loop = new AgentLoop({
      llm: readingLLM('storage_read', [
        join(own, 'MEMORY.md'),
        join(home, 'users', 'u1', 'USER.md'),
        join(home, 'memory.db'),
        join(home, 'work', 'notes.txt'),
        join(vault, 'journal.md'),
        join(own, 'files', 'logo.txt'),
      ]),
      tools,
      personalities: personalities(['read_file', 'storage_read']),
      storage: new FsStorage(),
      dataDir: home,
      privateMemoryRoots: [vault],
      safety: createTestSafety(),
      options: { workingDir: home },
    });
    await drain(loop.run('read', { roomAudience: 'shared' }));

    for (const p of [
      join(own, 'MEMORY.md'),
      join(home, 'users', 'u1', 'USER.md'),
      join(home, 'memory.db'),
      join(home, 'work', 'notes.txt'),
      join(vault, 'journal.md'),
    ]) {
      expect(out[p], p).toMatch(/^refused: .*shared-audience memory/);
    }
    expect(out[join(own, 'files', 'logo.txt')]).toBe('asset');
  });

  it('a private turn reads the same files (absent roomAudience = today)', async () => {
    const out: Outcome = {};
    const tools = new DefaultToolRegistry(backends());
    tools.register(scopedFsReader(out));
    await drain(loopFor(readingLLM('read_file', [join(own, 'MEMORY.md')]), tools).run('read'));
    expect(out[join(own, 'MEMORY.md')]).toBe(MEMORY_CONTENT);
  });

  it('the attachments rebuild of scopedFs keeps the deny', () => {
    const resolved = resolveCapabilities(
      'vision',
      { fs_reach: { read: 'from-personality' }, attachments: { kinds: ['image'] } },
      { sessionId: 's', personalityId: 'lean', roomAudience: 'shared' },
      {
        ...backends(),
        attachmentCache: new InMemoryAttachmentCache(),
        inboundAttachments: [
          {
            ref: 'a1',
            type: 'image',
            url: 'file:///tmp/ethos-test-cache/attachments/s/m/a1.png',
            mimeType: 'image/png',
          },
        ],
      },
    );
    return expect(resolved.scopedFs?.read(join(own, 'MEMORY.md'))).rejects.toThrow(
      /^PATH_NOT_REACHABLE: .*shared conversation/,
    );
  });
});

// Verification round E4 — a shared turn can read nothing under the Ethos state
// directory except its own files/, ui/, SOUL.md and the skills
// (`sharedTurnDenyFor` → `sharedTurnPathDeny`). The cwd IS the state dir here,
// so the allowlist admits every path and only the deny can refuse.
describe('E4 — a shared turn reads nothing else under the state dir', () => {
  let home: string;
  let own: string;

  const refusedReads = (h: string) => [
    join(h, 'cron', 'output', 'daily', '2026-09-28.md'),
    join(h, 'compaction', 'lean', 'summary.md'),
    join(h, 'sessions.db'),
    join(h, 'config.yaml'),
    join(h, 'cron', 'jobs.json'),
    join(h, 'personalities', 'other', 'files', 'secret.txt'),
    join(h, 'personalities', 'lean', 'config.yaml'),
  ];

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-e4-')));
    own = join(home, 'personalities', 'lean');
    for (const d of [
      join(own, 'files'),
      join(own, 'ui'),
      join(home, 'skills', 'digest'),
      join(home, 'cron', 'output', 'daily'),
      join(home, 'compaction', 'lean'),
      join(home, 'personalities', 'other', 'files'),
      join(own, 'skills', 'mine'),
      join(home, 'personalities', 'other', 'skills', 'theirs'),
    ]) {
      await mkdir(d, { recursive: true });
    }
    await writeFile(join(own, 'skills', 'mine', 'SKILL.md'), 'own skill');
    await writeFile(
      join(home, 'personalities', 'other', 'skills', 'theirs', 'SKILL.md'),
      'their skill',
    );
    for (const p of refusedReads(home)) await writeFile(p, `private:${p}`);
    await writeFile(join(own, 'files', 'logo.txt'), 'asset');
    await writeFile(join(own, 'ui', 'report.html'), '<p>template</p>');
    await writeFile(join(own, 'SOUL.md'), 'I am lean.');
    await writeFile(join(home, 'skills', 'digest', 'SKILL.md'), 'skill body');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  interface Op {
    path: string;
    write?: string;
  }

  function opsLLM(ops: Op[]): LLMProvider {
    let n = 0;
    return {
      name: 'mock',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(): AsyncIterable<CompletionChunk> {
        if (n++ === 0) {
          for (const [i, op] of ops.entries()) {
            yield { type: 'tool_use_start', toolCallId: `c${i}`, toolName: 'storage_op' };
            yield { type: 'tool_use_end', toolCallId: `c${i}`, inputJson: JSON.stringify(op) };
          }
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

  /** Reads (or, with `write`, writes) through the turn's scoped `ctx.storage`. */
  function storageOp(out: Record<string, string>): Tool {
    return {
      name: 'storage_op',
      description: 'storage',
      toolset: 'file',
      capabilities: {},
      schema: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(input, ctx) {
        const op = input as Op;
        const key = op.write === undefined ? op.path : `write:${op.path}`;
        try {
          if (!ctx.storage) throw new Error('no storage');
          if (op.write === undefined) out[key] = (await ctx.storage.read(op.path)) ?? '(missing)';
          else {
            await ctx.storage.write(op.path, op.write);
            out[key] = 'written';
          }
        } catch (err) {
          out[key] = `refused: ${err instanceof Error ? err.message : String(err)}`;
        }
        return { ok: true, value: 'done' };
      },
    };
  }

  async function runOps(
    ops: Op[],
    roomAudience?: 'shared',
    extra: Partial<PersonalityConfig> = {},
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const tools = new DefaultToolRegistry();
    tools.register(storageOp(out));
    const loop = new AgentLoop({
      llm: opsLLM(ops),
      tools,
      personalities: personalities(['storage_op'], extra),
      storage: new FsStorage(),
      dataDir: home,
      safety: createTestSafety(),
      options: { workingDir: home },
    });
    await drain(loop.run('go', roomAudience ? { roomAudience } : {}));
    return out;
  }

  it('refuses cron output, compaction, sessions.db, config.yaml, jobs and another personality’s files', async () => {
    const out = await runOps(
      refusedReads(home).map((path) => ({ path })),
      'shared',
    );
    for (const p of refusedReads(home)) {
      expect(out[p], p).toMatch(/^refused: .*shared-audience memory/);
    }
    expect(JSON.stringify(out)).not.toContain('private:');
  });

  it('refuses the state dir under its macOS firmlink name', async () => {
    const firmlinked = join('/System/Volumes/Data', home, 'config.yaml');
    const deny = sharedTurnDenyFor('shared', { stateDirs: [home] }, 'lean');
    expect(deny?.(firmlinked, 'access', 'read')).toBe(true);
    expect(deny?.(join('/System/Volumes/Data', own, 'files', 'a.png'), 'access', 'read')).toBe(
      false,
    );
  });

  // verification round G3 — `/.nofollow/<abs>` is `<abs>` on macOS.
  it('refuses the state dir under its macOS /.nofollow name', () => {
    const deny = sharedTurnDenyFor('shared', { stateDirs: [home] }, 'lean');
    expect(deny?.(`/.nofollow${home}/config.yaml`, 'access', 'read')).toBe(true);
    expect(deny?.(`/.NOFOLLOW${home}/cron/output/daily/x.md`, 'access', 'read')).toBe(true);
    expect(deny?.(`/.nofollow${own}/files/a.png`, 'access', 'read')).toBe(false);
  });

  it('still reads its own files/, ui/ and SOUL.md and the skills, and writes files/', async () => {
    const out = await runOps(
      [
        { path: join(own, 'files', 'logo.txt') },
        { path: join(own, 'ui', 'report.html') },
        { path: join(own, 'SOUL.md') },
        { path: join(home, 'skills', 'digest', 'SKILL.md') },
        { path: join(own, 'skills', 'mine', 'SKILL.md') },
        { path: join(home, 'personalities', 'other', 'skills', 'theirs', 'SKILL.md') },
        { path: join(own, 'files', 'new.txt'), write: 'made in the room' },
        { path: join(own, 'SOUL.md'), write: 'rewritten' },
        { path: join(home, 'skills', 'digest', 'SKILL.md'), write: 'poisoned' },
      ],
      'shared',
    );
    expect(out[join(own, 'files', 'logo.txt')]).toBe('asset');
    expect(out[join(own, 'ui', 'report.html')]).toBe('<p>template</p>');
    expect(out[join(own, 'SOUL.md')]).toBe('I am lean.');
    expect(out[join(home, 'skills', 'digest', 'SKILL.md')]).toBe('skill body');
    // verification round G9 — its own skills are readable; another's are not.
    expect(out[join(own, 'skills', 'mine', 'SKILL.md')]).toBe('own skill');
    expect(out[join(home, 'personalities', 'other', 'skills', 'theirs', 'SKILL.md')]).toMatch(
      /^refused: .*shared-audience memory/,
    );
    expect(out[`write:${join(own, 'files', 'new.txt')}`]).toBe('written');
    expect(out[`write:${join(own, 'SOUL.md')}`]).toMatch(/^refused:/);
    expect(out[`write:${join(home, 'skills', 'digest', 'SKILL.md')}`]).toMatch(/^refused:/);
  });

  // The working dir IS the state dir here, which UBP-047 drops from the
  // DEFAULT reach; a declared workdir is an explicit grant and is kept.
  it('a private turn is unaffected', async () => {
    const out = await runOps(
      [{ path: join(home, 'cron', 'output', 'daily', '2026-09-28.md') }],
      undefined,
      { fs_reach: { workdir: home } },
    );
    expect(out[join(home, 'cron', 'output', 'daily', '2026-09-28.md')]).toMatch(/^private:/);
  });

  it('warns once per personality when the read reach covers /', async () => {
    const warnings: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warnings.push(m),
      error: () => {},
      child() {
        return this;
      },
    };
    const loop = new AgentLoop({
      llm: opsLLM([]),
      tools: new DefaultToolRegistry(),
      personalities: personalities([]),
      storage: new FsStorage(),
      dataDir: home,
      safety: createTestSafety(),
      logger,
      options: { workingDir: '/' },
    });
    await drain(loop.run('one'));
    await drain(loop.run('two'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"lean" can read the whole filesystem');
  });
});

// Verification round G1 — the gateway caches a message's attachments under
// `<state>/cache/attachments/<session>/<message>/`, which a shared turn's
// state-dir deny refuses. `resolveCapabilities` exempts exactly THIS turn's
// attachment directories, for reading (`exemptAttachmentReads`).
describe('G1 — a shared turn reads its own attachments, and no one else’s', () => {
  let home: string;
  let cache: FsAttachmentCache;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-g1-att-')));
    cache = new FsAttachmentCache(new FsStorage(), join(home, 'cache', 'attachments'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function resolvedFs(roomAudience: 'shared' | 'private', url: string) {
    return resolveCapabilities(
      'read_file',
      { fs_reach: { read: 'from-personality' }, attachments: { kinds: ['file'] } },
      { sessionId: 's', personalityId: 'lean', roomAudience },
      {
        storage: new FsStorage(),
        // The whole state dir is in reach, so only the deny can refuse.
        personalityFsReach: () => ({ read: [`${home}/`], write: [] }),
        privateMemoryRoots: { stateDirs: [home] },
        attachmentCache: cache,
        inboundAttachments: [{ ref: 'a1', type: 'file', url, mimeType: 'application/pdf' }],
      },
    ).scopedFs;
  }

  it('reads this turn’s attachment but not another session’s, and writes neither', async () => {
    const enc = new TextEncoder();
    const mine = await cache.write(enc.encode('room doc'), {
      sessionKey: 'telegram:bot:-100',
      messageId: 'm1',
      filename: 'doc.pdf',
      mime: 'application/pdf',
    });
    const theirs = await cache.write(enc.encode('private doc'), {
      sessionKey: 'telegram:bot:42',
      messageId: 'm9',
      filename: 'doc.pdf',
      mime: 'application/pdf',
    });
    const fs = await resolvedFs('shared', mine);
    expect(await fs?.read(cache.resolveLocalPath(mine))).toBe('room doc');
    await expect(fs?.read(cache.resolveLocalPath(theirs))).rejects.toThrow(
      /^PATH_NOT_REACHABLE: .*shared conversation/,
    );
    await expect(fs?.write(cache.resolveLocalPath(mine), 'x')).rejects.toThrow(
      /PATH_NOT_REACHABLE/,
    );
    await expect(fs?.read(join(home, 'config.yaml'))).rejects.toThrow(/shared conversation/);
  });

  it('a private turn reads either (no deny to exempt from)', async () => {
    const enc = new TextEncoder();
    const theirs = await cache.write(enc.encode('private doc'), {
      sessionKey: 'telegram:bot:42',
      messageId: 'm9',
      filename: 'doc.pdf',
      mime: 'application/pdf',
    });
    const fs = await resolvedFs('private', theirs);
    expect(await fs?.read(cache.resolveLocalPath(theirs))).toBe('private doc');
  });
});
