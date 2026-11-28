// Initiative runs may call the three world READ tools, only when a world port is composed
// (`world.enabled`), and only see what an incognito, shared-audience turn may see.
//
//   - registration: `buildReadOnlyRegistry` registers world_query / world_neighbours /
//     world_history when `InitiativeToolDeps.worldPort` is set and the personality toolset lists
//     them; with no port nothing is registered and nothing throws; the world write tools are
//     never registered (they are INITIATIVE_NEVER_TOOLS). L3 (`assertReadOnlyCapabilities`)
//     runs inside `buildReadOnlyRegistry`, so a registry that builds has passed it.
//   - R6: a REAL AgentLoop run with `readOnlyRunOptions` (incognito, so the turn resolves to
//     'shared', packages/core/src/agent-loop/audience.ts) reaches `world_query` with a shared
//     caller, so `resolveAccess` drops the owner_only world and the personality's private world.

import { DefaultPersonalityRegistry } from '@ethosagent/core';
import {
  createReadOnlyLoop,
  createReadOnlyLoopParts,
  readOnlyRunOptions,
  runToolNames,
} from '@ethosagent/initiative-runner';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { WORLD_TOOL_NAMES } from '@ethosagent/tools-world';
import type {
  AgentEvent,
  CompletionChunk,
  InitiativeLedgerPort,
  LLMProvider,
  MemoryProvider,
  PersonalityConfig,
  SessionStore,
  Tool,
  ToolResult,
} from '@ethosagent/types';
import type { WorldToolPort } from '@ethosagent/world-service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addWorld,
  type ToolHarness,
  textOf,
  toolHarness,
} from '../../../../extensions/tools-world/src/__tests__/harness';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import {
  buildReadOnlyRegistry,
  defaultInitiativeToolFactories,
  type InitiativeToolFactories,
} from '../initiatives';

const READS = ['world_query', 'world_neighbours', 'world_history'];
const WRITES = WORLD_TOOL_NAMES.filter((n) => !READS.includes(n));
const ACME = 'world:acme' as const;
const OPS = 'world:ops' as const;
const PRIVATE = 'personality:engineer' as const;

function factoriesWith(worldPort?: WorldToolPort): InitiativeToolFactories {
  return defaultInitiativeToolFactories({
    env: {},
    toolsConfig: () => undefined,
    memory: {} as MemoryProvider,
    session: {} as SessionStore,
    ...(worldPort ? { worldPort } : {}),
  });
}

function registryFor(factories: InitiativeToolFactories, toolset?: string[]) {
  const personality: PersonalityConfig = {
    id: 'engineer',
    name: 'engineer',
    ...(toolset ? { toolset } : {}),
  };
  const registry = buildReadOnlyRegistry({
    personality,
    ledger: {} as InitiativeLedgerPort,
    initiativeId: 'INI-1',
    sourcePaths: [],
    factories,
    storage: new InMemoryStorage(),
    dataDir: '/ethos-state',
  });
  return { personality, registry };
}

describe('initiative run registry: world reads', () => {
  let h: ToolHarness;
  beforeEach(async () => {
    h = await toolHarness();
  });
  afterEach(() => h.dispose());

  it('world enabled: the three world reads are registered, no world write is', () => {
    const { registry } = registryFor(factoriesWith(h.port));
    const names = registry.getAvailable().map((t) => t.name);
    for (const n of READS) expect(names).toContain(n);
    for (const n of WRITES) expect(names).not.toContain(n);
  });

  it('world enabled: the personality toolset still intersects (it can only remove)', () => {
    const none = registryFor(factoriesWith(h.port), ['read_file']);
    expect(none.registry.getAvailable().map((t) => t.name)).not.toContain('world_query');
    const one = registryFor(factoriesWith(h.port), ['world_query', 'world_assert']);
    const names = one.registry.getAvailable().map((t) => t.name);
    expect(names).toContain('world_query');
    expect(names).not.toContain('world_neighbours');
    expect(names).not.toContain('world_assert');
  });

  it('world disabled: no world tool is registered and nothing throws', () => {
    const { registry } = registryFor(factoriesWith(undefined));
    const names = registry.getAvailable().map((t) => t.name);
    expect(names.filter((n) => n.startsWith('world_'))).toEqual([]);
  });

  it('runToolNames lists the reads for an unrestricted toolset', () => {
    for (const n of READS) expect(runToolNames(undefined)).toContain(n);
    for (const n of WRITES) expect(runToolNames(undefined)).not.toContain(n);
  });
});

interface Call {
  name: string;
  input: Record<string, unknown>;
}

function scriptedLLM(calls: Call[]): LLMProvider {
  let n = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      n++;
      if (n > 1) {
        yield { type: 'text_delta', text: 'finished' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      for (const [i, c] of calls.entries()) {
        const id = `call-${i}`;
        const json = JSON.stringify(c.input);
        yield { type: 'tool_use_start', toolCallId: id, toolName: c.name };
        yield { type: 'tool_use_delta', toolCallId: id, partialJson: json };
        yield { type: 'tool_use_end', toolCallId: id, inputJson: json };
      }
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

describe('initiative run: world reads obey R6 (incognito run is a shared turn)', () => {
  let h: ToolHarness;
  beforeEach(async () => {
    h = await toolHarness();
  });
  afterEach(() => h.dispose());

  /** Runs one scripted initiative turn and returns each world tool's result, keyed by its `world` arg ('' when absent). */
  async function runWith(calls: Call[]): Promise<Map<string, ToolResult>> {
    const byWorld = new Map<string, ToolResult>();
    const base = factoriesWith(h.port);
    const factories: InitiativeToolFactories = {
      ...base,
      read: base.read.map(
        (make) => () =>
          make().map(
            (tool): Tool =>
              tool.name.startsWith('world_')
                ? {
                    ...tool,
                    execute: async (args, ctx) => {
                      const r = await tool.execute(args, ctx);
                      const world =
                        typeof args === 'object' && args !== null && 'world' in args
                          ? String(args.world)
                          : '';
                      byWorld.set(world, r);
                      return r;
                    },
                  }
                : tool,
          ),
      ),
    };
    const { personality, registry } = registryFor(factories);
    const personalities = new DefaultPersonalityRegistry();
    personalities.define(personality);
    const loop = createReadOnlyLoop(
      createReadOnlyLoopParts({
        personalities,
        tools: registry,
        llm: scriptedLLM(calls),
        safety: createTestSafety(),
        allowed: new Set(runToolNames(personality.toolset)),
      }),
    );
    const events: AgentEvent[] = [];
    for await (const e of loop.run(
      'explore',
      readOnlyRunOptions({
        personalityId: 'engineer',
        initiativeId: 'INI-1',
        windowId: 'W-1',
        abortSignal: new AbortController().signal,
      }),
    )) {
      events.push(e);
    }
    return byWorld;
  }

  it('an owner_only world and the private personality world are invisible; a shareable one is read', async () => {
    await addWorld(h, 'ops', { audience: 'owner_only' });
    h.provider.seedEntity(ACME, 'Person', 'Ravi');
    h.provider.seedEntity(OPS, 'Person', 'Ravi');
    h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');

    const byWorld = await runWith([
      { name: 'world_query', input: { text: 'Ravi' } },
      { name: 'world_query', input: { text: 'Ravi', world: 'ops' } },
    ]);
    const all = byWorld.get('');
    const named = byWorld.get('ops');
    expect(all?.ok, JSON.stringify(all)).toBe(true);
    const text = textOf(all as ToolResult);
    expect(text).toContain('acme:Ravi');
    expect(text).not.toContain('ops:Ravi');
    expect(text).not.toContain('private:Ravi');
    expect(named?.ok).toBe(false);
    expect(textOf(named as ToolResult)).toContain('not_mounted');
  });
});
