// Containment 3a — the turn's ONE `fs_reach` derivation (turn-setup) carries
// `writeDeny` through `buildScopedStorage` to `AgentSafety.scopedStorageFactory`,
// the factory that builds `ToolContext.storage` for every tool call.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Storage,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { personalityWriteDeny } from '../fs-reach';
import { DefaultHookRegistry } from '../hook-registry';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

const DATA_DIR = '/home/tester/.ethos';

/** One `probe` call on the first round, plain text on the second. */
function scriptedLLM(): LLMProvider {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_use_start', toolCallId: 't1', toolName: 'probe' };
        yield { type: 'tool_use_end', toolCallId: 't1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function probeTools(): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'probe',
    description: 'probe',
    schema: { type: 'object' },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: 'ok' };
    },
  });
  return tools;
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // drain
  }
}

describe('turn setup threads writeDeny into the scoped storage factory', () => {
  it('the factory receives the personality definition as writeDeny', async () => {
    const scopes: Array<{ read: string[]; write: string[]; writeDeny?: string[] }> = [];
    const hooks = new DefaultHookRegistry();
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools: probeTools(),
      hooks,
      session: new InMemorySessionStore(),
      storage: new InMemoryStorage(),
      dataDir: DATA_DIR,
      safety: createTestSafety({
        scopedStorageFactory: (base: Storage, scope) => {
          scopes.push(scope);
          return base;
        },
      }),
    });

    await drain(loop.run('go', { sessionKey: 'cli:fs-reach' }));

    expect(scopes.length).toBeGreaterThan(0);
    const scope = scopes[0];
    expect(scope?.writeDeny).toEqual(personalityWriteDeny(DATA_DIR, 'default'));
    // The definition sits inside the write reach — that is why it needs a deny.
    expect(scope?.write).toContain(`${DATA_DIR}/personalities/default/`);
  });
});
