import type { MemoryContext, PromptContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  translateBeforePromptBuildHook,
  translateCorpusSupplement,
  translateMemoryCapability,
  translateMemoryRuntime,
  translatePromptSectionBuilder,
} from '../memory-translator';
import type { MemoryPluginCapability, MemoryPluginRuntime } from '../types';

const baseLoadCtx: MemoryContext = {
  scopeId: 'global',
  sessionId: 'sess-1',
  sessionKey: 'key-1',
  platform: 'cli',
  workingDir: '/tmp',
};

const basePromptCtx: PromptContext = {
  sessionId: 'sess-1',
  sessionKey: 'key-1',
  platform: 'cli',
  model: 'claude-sonnet-4-6',
  history: [],
  isDm: false,
  turnNumber: 1,
};

// ---------------------------------------------------------------------------
// translateMemoryCapability
// ---------------------------------------------------------------------------

describe('translateMemoryCapability', () => {
  it('returns null when no promptBuilder or runtime', async () => {
    const provider = translateMemoryCapability({});
    expect(await provider.prefetch(baseLoadCtx)).toBeNull();
  });

  it('uses promptBuilder when present', async () => {
    const cap: MemoryPluginCapability = {
      promptBuilder: () => ['memory line 1', 'memory line 2'],
    };
    const provider = translateMemoryCapability(cap);
    const result = await provider.prefetch(baseLoadCtx);
    expect(result).not.toBeNull();
    expect(result?.entries[0]?.content).toBe('memory line 1\nmemory line 2');
  });

  it('returns null when promptBuilder returns empty array', async () => {
    const cap: MemoryPluginCapability = { promptBuilder: () => [] };
    const provider = translateMemoryCapability(cap);
    expect(await provider.prefetch(baseLoadCtx)).toBeNull();
  });

  it('delegates to runtime search when no promptBuilder', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return {
          manager: {
            async search() {
              return [{ content: 'result from runtime', id: '1', score: 0.9 }];
            },
          },
        };
      },
    };
    const cap: MemoryPluginCapability = { runtime };
    const provider = translateMemoryCapability(cap);
    const results = await provider.search('what do I know?', baseLoadCtx);
    expect(results.length).toBe(1);
    expect(results[0]?.content).toContain('result from runtime');
  });

  it('sync() resolves without throwing', async () => {
    const provider = translateMemoryCapability({});
    await expect(provider.sync([], baseLoadCtx)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// translateMemoryRuntime
// ---------------------------------------------------------------------------

describe('translateMemoryRuntime', () => {
  it('prefetch always returns null (runtime providers are search-driven)', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return { manager: null };
      },
    };
    const provider = translateMemoryRuntime(runtime);
    expect(await provider.prefetch(baseLoadCtx)).toBeNull();
  });

  it('search() returns [] when manager is null', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return { manager: null };
      },
    };
    const provider = translateMemoryRuntime(runtime);
    expect(await provider.search('hello', baseLoadCtx)).toEqual([]);
  });

  it('search() returns [] for empty query', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return {
          manager: {
            async search() {
              return [{ content: 'never', id: '1' }];
            },
          },
        };
      },
    };
    const provider = translateMemoryRuntime(runtime);
    expect(await provider.search('   ', baseLoadCtx)).toEqual([]);
  });

  it('search() returns [] when manager has no search method', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return { manager: {} };
      },
    };
    const provider = translateMemoryRuntime(runtime);
    expect(await provider.search('hello', baseLoadCtx)).toEqual([]);
  });

  it('search() returns [] when getMemorySearchManager throws', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        throw new Error('connection failed');
      },
    };
    const provider = translateMemoryRuntime(runtime);
    expect(await provider.search('hello', baseLoadCtx)).toEqual([]);
  });

  it('search() returns mapped entries from runtime', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return {
          manager: {
            async search({ query }: { query: string }) {
              return [
                { content: `result A for: ${query}`, id: '1', score: 0.9 },
                { content: 'result B', id: '2', score: 0.7 },
              ];
            },
          },
        };
      },
    };
    const provider = translateMemoryRuntime(runtime);
    const results = await provider.search('who am I?', baseLoadCtx);
    expect(results.length).toBe(2);
    expect(results[0]?.content).toContain('result A for: who am I?');
    expect(results[1]?.content).toContain('result B');
  });

  it('search() returns [] when runtime search returns empty array', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return {
          manager: {
            async search() {
              return [];
            },
          },
        };
      },
    };
    const provider = translateMemoryRuntime(runtime);
    expect(await provider.search('anything', baseLoadCtx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// translatePromptSectionBuilder → ContextInjector
// ---------------------------------------------------------------------------

describe('translatePromptSectionBuilder', () => {
  it('returns injector with correct id and priority', () => {
    const injector = translatePromptSectionBuilder('my-plugin', () => ['line'], 3);
    expect(injector.id).toBe('openclaw-my-plugin-prompt-section-3');
    expect(injector.priority).toBe(90);
  });

  it('respects custom priority', () => {
    const injector = translatePromptSectionBuilder('p', () => [], 0, 50);
    expect(injector.priority).toBe(50);
  });

  it('inject() returns null for empty lines', async () => {
    const injector = translatePromptSectionBuilder('p', () => [], 0);
    expect(await injector.inject(basePromptCtx)).toBeNull();
  });

  it('inject() returns prepend result with joined lines', async () => {
    const injector = translatePromptSectionBuilder('p', () => ['A', 'B'], 0);
    const result = await injector.inject(basePromptCtx);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('A\nB');
    expect(result?.position).toBe('prepend');
  });
});

// ---------------------------------------------------------------------------
// translateCorpusSupplement → ContextInjector
// ---------------------------------------------------------------------------

describe('translateCorpusSupplement', () => {
  it('returns null when no query in context', async () => {
    const supplement = {
      async search() {
        return [];
      },
      async get() {
        return null;
      },
    };
    const injector = translateCorpusSupplement('p', supplement, 0);
    expect(await injector.inject(basePromptCtx)).toBeNull();
  });

  it('returns content when search returns results', async () => {
    const supplement = {
      async search({ query }: { query: string }) {
        return [{ id: '1', content: `found: ${query}`, score: 1 }];
      },
      async get() {
        return null;
      },
    };
    const injector = translateCorpusSupplement('p', supplement, 0);
    const ctx = { ...basePromptCtx, query: 'test search' } as PromptContext & { query: string };
    const result = await injector.inject(ctx);
    expect(result).not.toBeNull();
    expect(result?.content).toContain('found: test search');
  });
});

// ---------------------------------------------------------------------------
// translateBeforePromptBuildHook → ContextInjector
// ---------------------------------------------------------------------------

describe('translateBeforePromptBuildHook', () => {
  it('id and priority are derived from pluginId, idx, and opts', () => {
    const injector = translateBeforePromptBuildHook('lancedb', vi.fn(), 2, 95);
    expect(injector.id).toBe('openclaw-lancedb-before-prompt-build-2');
    expect(injector.priority).toBe(95);
  });

  it('returns null when handler returns falsy', async () => {
    const injector = translateBeforePromptBuildHook('p', vi.fn().mockResolvedValue(null), 0);
    expect(await injector.inject(basePromptCtx)).toBeNull();
  });

  it('returns prepend result when handler returns prependContext', async () => {
    const handler = vi.fn().mockResolvedValue({ prependContext: 'recalled memory' });
    const injector = translateBeforePromptBuildHook('p', handler, 0);
    const result = await injector.inject(basePromptCtx);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('recalled memory');
    expect(result?.position).toBe('prepend');
  });

  it('returns append result when handler returns appendContext', async () => {
    const handler = vi.fn().mockResolvedValue({ appendContext: 'appended' });
    const injector = translateBeforePromptBuildHook('p', handler, 0);
    const result = await injector.inject(basePromptCtx);
    expect(result?.position).toBe('append');
  });

  it('returns null when handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('oops'));
    const injector = translateBeforePromptBuildHook('p', handler, 0);
    expect(await injector.inject(basePromptCtx)).toBeNull();
  });

  it('passes sessionId to handler context', async () => {
    const handler = vi.fn().mockResolvedValue({});
    const injector = translateBeforePromptBuildHook('p', handler, 0);
    const ctx = { ...basePromptCtx, sessionId: 'test-session' };
    await injector.inject(ctx);
    const [, hookCtx] = handler.mock.calls[0] as [unknown, { sessionId: string }];
    expect(hookCtx.sessionId).toBe('test-session');
  });
});
