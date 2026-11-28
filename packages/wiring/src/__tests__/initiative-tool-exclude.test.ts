// The initiative chat tools (initiative_define, initiative_add_ideas) are on by default and
// hidden per personality when its settings.yaml says `enabled: false` or the constitution's
// `initiatives.enabled` kill switch is false. The decision is cached per personality, so a
// personality's tool list is byte-stable across turns and flips only on `reload`.

import { dirname } from 'node:path';
import { AgentLoop, DefaultPersonalityRegistry, DefaultToolRegistry } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  CompletionOptions,
  Constitution,
  LLMProvider,
  Tool,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import { createInitiativeEnablement } from '../initiatives';
import { buildPersonalityToolExclude } from '../personality-tool-exclude';

const DATA = '/home/u/.ethos';
const CHAT_TOOLS = [
  'initiative_define',
  'initiative_add_ideas',
  'initiative_list',
  'initiative_search',
  'initiative_get',
];
const settingsPath = (id: string) => `${DATA}/personalities/${id}/initiatives/settings.yaml`;

async function setup(opts: {
  settings?: Record<string, string>;
  constitution?: Constitution;
  ids?: string[];
}) {
  const storage = new InMemoryStorage();
  for (const [id, yaml] of Object.entries(opts.settings ?? {})) {
    await storage.mkdir(dirname(settingsPath(id)));
    await storage.writeAtomic(settingsPath(id), yaml);
  }
  const constitution = { current: opts.constitution ?? {} };
  const enablement = await createInitiativeEnablement({
    storage,
    dataDir: DATA,
    personalityIds: () => opts.ids ?? ['a', 'b'],
    constitution: async () => constitution.current,
  });
  const exclude = buildPersonalityToolExclude(undefined, { initiatives: enablement });
  return { storage, constitution, enablement, exclude };
}

const person = (id: string) => ({ id, name: id, toolset: ['propose_self_amendment'] });

describe('initiative chat tool exclusion', () => {
  it('feature off hides the chat tools', async () => {
    const off = await setup({ settings: { a: 'enabled: false\n' } });
    expect(off.exclude(person('a'))).toEqual(expect.arrayContaining(CHAT_TOOLS));
    // only the personality that turned it off
    expect(off.exclude(person('b'))).toEqual([]);

    const killed = await setup({ constitution: { initiatives: { enabled: false } } });
    expect(killed.exclude(person('a'))).toEqual(expect.arrayContaining(CHAT_TOOLS));
    expect(killed.exclude(person('b'))).toEqual(expect.arrayContaining(CHAT_TOOLS));
  });

  it('an invalid settings.yaml pauses the feature for that personality only', async () => {
    const s = await setup({ settings: { a: 'enabled: [nope\n' } });
    expect(s.exclude(person('a'))).toEqual(expect.arrayContaining(CHAT_TOOLS));
    expect(s.exclude(person('b'))).toEqual([]);
  });

  it('on by default for a personality with no settings.yaml', async () => {
    const s = await setup({});
    expect(s.exclude(person('a'))).toEqual([]);
    // a personality that was not known at compose time is also on
    expect(s.exclude(person('later'))).toEqual([]);
  });

  it('flips only on reload after a toggle', async () => {
    const s = await setup({});
    await s.storage.mkdir(dirname(settingsPath('a')));
    await s.storage.writeAtomic(settingsPath('a'), 'enabled: false\n');
    expect(s.exclude(person('a'))).toEqual([]);
    await s.enablement.reload('a');
    expect(s.exclude(person('a'))).toEqual(expect.arrayContaining(CHAT_TOOLS));

    s.constitution.current = { initiatives: { enabled: false } };
    expect(s.exclude(person('b'))).toEqual([]);
    await s.enablement.reload();
    expect(s.exclude(person('b'))).toEqual(expect.arrayContaining(CHAT_TOOLS));
  });
});

function capturingLLM(seen: ToolDefinitionLite[][]): LLMProvider {
  return {
    name: 'capture',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _m: unknown,
      tools: ToolDefinitionLite[],
      _o: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      seen.push(tools);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

const chatTool = (name: string): Tool => ({
  name,
  description: name,
  schema: { type: 'object' },
  capabilities: {},
  alwaysInclude: true,
  execute: async () => ({ ok: true, value: 'ok' }),
});

describe('prompts for personalities are unchanged across turns', () => {
  it('sends the same tool list every turn and changes it only after a toggle', async () => {
    const s = await setup({ ids: ['a'] });
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'a', name: 'a' });
    personalities.setDefault('a');
    const tools = new DefaultToolRegistry();
    for (const n of CHAT_TOOLS) tools.register(chatTool(n));
    const seen: ToolDefinitionLite[][] = [];
    const loop = new AgentLoop({
      llm: capturingLLM(seen),
      tools,
      personalities,
      safety: createTestSafety(),
      personalityToolExclude: s.exclude,
    });
    const drain = async () => {
      for await (const _e of loop.run('hi', { roomAudience: 'private' })) {
        // drained to exhaustion
      }
    };
    await drain();
    await drain();
    expect(seen[0]?.map((t) => t.name)).toEqual(expect.arrayContaining(CHAT_TOOLS));
    expect(JSON.stringify(seen[0])).toBe(JSON.stringify(seen[1]));

    await s.storage.mkdir(dirname(settingsPath('a')));
    await s.storage.writeAtomic(settingsPath('a'), 'enabled: false\n');
    await drain(); // not reloaded yet: unchanged
    expect(JSON.stringify(seen[2])).toBe(JSON.stringify(seen[0]));
    await s.enablement.reload('a');
    await drain();
    expect(seen[3]?.map((t) => t.name)).not.toContain('initiative_define');
  });
});
