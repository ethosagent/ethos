import { DefaultToolRegistry, type RunOptions } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Tool,
  ToolContext,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import {
  createReadOnlyLoop,
  createReadOnlyLoopParts,
  readOnlyCapabilityBackends,
  readOnlyLoopConfig,
  readOnlyRunOptions,
} from '../index';

function scriptedLLM(
  toolName: string | null,
  opts: { maxContextTokens?: number } = {},
): LLMProvider {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: opts.maxContextTokens ?? 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls > 1 || toolName === null) {
        yield { type: 'text_delta', text: 'finished' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      yield { type: 'tool_use_start', toolCallId: 'c1', toolName };
      yield { type: 'tool_use_delta', toolCallId: 'c1', partialJson: '{}' };
      yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

const runInput = {
  initiativeId: 'INI-1',
  windowId: 'W-1',
  abortSignal: new AbortController().signal,
};

async function runSpy(tool: Tool, backends: ReturnType<typeof readOnlyCapabilityBackends>) {
  const tools = new DefaultToolRegistry(backends);
  tools.register(tool);
  const parts = createReadOnlyLoopParts({
    tools,
    llm: scriptedLLM(tool.name),
    safety: createTestSafety(),
    allowed: new Set([tool.name]),
  });
  const loop = createReadOnlyLoop(parts);
  for await (const _e of loop.run('go', readOnlyRunOptions(runInput))) {
    // drained
  }
}

describe('L5 read-only run context', () => {
  it('ctx has no write reach', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/src');
    await storage.write('/src/a.txt', 'hi');
    let seen: ToolContext | undefined;
    const spy: Tool = {
      name: 'spy',
      description: 'spy',
      schema: { type: 'object' },
      capabilities: { fs_reach: { read: 'from-personality', write: 'from-personality' } },
      execute: async (_a, ctx) => {
        seen = ctx;
        return { ok: true, value: 'ok' };
      },
    };
    await runSpy(
      spy,
      readOnlyCapabilityBackends({
        storage,
        sourcePaths: ['/src'],
        alwaysDenyPaths: [],
        stateDirs: [],
      }),
    );
    expect(seen?.scopedFs).toBeDefined();
    expect(await seen?.scopedFs?.read('/src/a.txt')).toBe('hi');
    await expect(seen?.scopedFs?.write('/src/b.txt', 'x')).rejects.toThrow();
    await expect(seen?.scopedFs?.write('/elsewhere/b.txt', 'x')).rejects.toThrow();
    expect(await storage.exists('/src/b.txt')).toBe(false);
    expect(seen?.scopedProcess).toBeUndefined();
    expect(seen?.kvStore).toBeUndefined();
  });

  it('kvStore is never resolved even for a tool that declares storage', async () => {
    let seen: ToolContext | undefined;
    const spy: Tool = {
      name: 'spy',
      description: 'spy',
      schema: { type: 'object' },
      capabilities: { storage: { scope: 'session', kind: 'kv' } },
      execute: async (_a, ctx) => {
        seen = ctx;
        return { ok: true, value: 'ok' };
      },
    };
    await runSpy(
      spy,
      readOnlyCapabilityBackends({
        storage: new InMemoryStorage(),
        sourcePaths: [],
        alwaysDenyPaths: [],
        stateDirs: [],
      }),
    );
    expect(seen?.kvStore).toBeUndefined();
  });

  it('secrets limited to declared search refs', async () => {
    let seen: ToolContext | undefined;
    const spy: Tool = {
      name: 'spy',
      description: 'spy',
      schema: { type: 'object' },
      capabilities: { secrets: ['providers/exa/*', 'providers/other/*'] },
      execute: async (_a, ctx) => {
        seen = ctx;
        return { ok: true, value: 'ok' };
      },
    };
    await runSpy(
      spy,
      readOnlyCapabilityBackends({
        storage: new InMemoryStorage(),
        sourcePaths: [],
        alwaysDenyPaths: [],
        stateDirs: [],
        secrets: {
          allowedRefs: ['providers/exa/*'],
          backend: async (ref) => `secret:${ref}`,
        },
      }),
    );
    expect(await seen?.secretsResolver?.get('providers/exa/apiKey')).toBe(
      'secret:providers/exa/apiKey',
    );
    await expect(seen?.secretsResolver?.get('providers/other/apiKey')).rejects.toThrow();
  });

  it('no secrets backend means no secrets resolver', async () => {
    let seen: ToolContext | undefined;
    const spy: Tool = {
      name: 'spy',
      description: 'spy',
      schema: { type: 'object' },
      capabilities: { secrets: ['providers/exa/*'] },
      execute: async (_a, ctx) => {
        seen = ctx;
        return { ok: true, value: 'ok' };
      },
    };
    await runSpy(
      spy,
      readOnlyCapabilityBackends({
        storage: new InMemoryStorage(),
        sourcePaths: [],
        alwaysDenyPaths: [],
        stateDirs: [],
      }),
    );
    expect(seen?.secretsResolver).toBeUndefined();
  });

  it('run options carry roomAudience and incognito', () => {
    const opts: RunOptions = readOnlyRunOptions({ ...runInput, model: 'm1' });
    expect(opts.sessionKey).toBe('initiative:INI-1:W-1');
    expect(opts.roomAudience).toBe('private');
    expect(opts.incognito).toBe(true);
    expect(opts.abortSignal).toBe(runInput.abortSignal);
    expect(opts.modelOverride).toBe('m1');
    expect('modelOverride' in readOnlyRunOptions(runInput)).toBe(false);
  });

  it('no memory flush and no auto-compaction', async () => {
    const parts = createReadOnlyLoopParts({
      tools: new DefaultToolRegistry(),
      llm: scriptedLLM(null, { maxContextTokens: 4_400 }),
      safety: createTestSafety(),
      allowed: new Set(),
    });
    const cfg = readOnlyLoopConfig(parts);
    expect(cfg.compaction?.autoCompact).toBe(false);
    expect(cfg.memoryConsolidation?.enabled).toBe(false);
    for (const k of [
      'storage',
      'dataDir',
      'memory',
      'observability',
      'injectors',
      'contextLog',
    ] as const) {
      expect(cfg[k], k).toBeUndefined();
    }
    expect(cfg.hooks).toBe(parts.hooks);
    expect(cfg.session).toBe(parts.session);

    // A large turn in a small window: no compaction record is written. The config assertions above are what pin autoCompact off.
    const events: AgentEvent[] = [];
    for await (const e of createReadOnlyLoop(parts).run(
      'x'.repeat(6_000),
      readOnlyRunOptions(runInput),
    )) {
      events.push(e);
    }
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events.at(-1)?.type).toBe('done');
    const s = await parts.session.getSessionByKey('initiative:INI-1:W-1');
    expect(s ? await parts.session.listCompressions(s.id) : []).toEqual([]);
  });
});
