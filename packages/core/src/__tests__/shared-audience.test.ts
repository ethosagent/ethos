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

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage, InMemoryAttachmentCache } from '@ethosagent/storage-fs';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import {
  memoryFlushForbidden,
  privateMemoryDenyFor,
  ROOM_AUDIENCE_METADATA_KEY,
  resolveTurnAudience,
  SHARED_AUDIENCE_EXCLUDED_TOOLS,
  sharedStampFor,
  withPersonalityMemoryWithheld,
  withSharedAudienceExclusions,
} from '../agent-loop/audience';
import { persistLoaded } from '../agent-loop/stages/tool-search';
import { type CapabilityBackends, resolveCapabilities } from '../capability-resolver';
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

  it('privateMemoryDenyFor: a predicate only on a shared turn; absent roots fail closed on ~/.ethos', () => {
    expect(privateMemoryDenyFor('private', { stateDirs: ['/s'] })).toBeUndefined();
    expect(privateMemoryDenyFor(undefined, { stateDirs: ['/s'] })).toBeUndefined();
    const deny = privateMemoryDenyFor('shared', { stateDirs: ['/s'] });
    expect(deny?.('/s/personalities/p/MEMORY.md', 'access')).toBe(true);
    expect(deny?.('/s/personalities/p/files/a.png', 'access')).toBe(false);
    const fallback = privateMemoryDenyFor('shared', undefined);
    expect(fallback?.(join(homedir(), '.ethos', 'users', 'u1', 'USER.md'), 'access')).toBe(true);
  });

  // Verification round A3 — one state-dir set: wired roots, `~/.ethos`,
  // `ETHOS_STATE_DIR`, and the realpath of each (a symlinked state dir).
  it('privateMemoryDenyFor: always adds ETHOS_STATE_DIR, ~/.ethos and realpaths', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'ethos-audience-roots-')));
    try {
      const real = join(tmp, 'real-state');
      const link = join(tmp, 'linked-state');
      await mkdir(real);
      await symlink(real, link);
      vi.stubEnv('ETHOS_STATE_DIR', link);
      const deny = privateMemoryDenyFor('shared', { stateDirs: ['/s'] });
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
    // Not persisted: the stranger's session carries no stamp.
    const stored = await session.getSessionByKey('telegram:bot:42');
    expect(stored?.metadata?.[ROOM_AUDIENCE_METADATA_KEY]).toBeUndefined();
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
