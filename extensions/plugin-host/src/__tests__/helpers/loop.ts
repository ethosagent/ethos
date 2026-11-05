import {
  AgentLoop,
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { PluginApiImpl } from '@ethosagent/plugin-sdk';
import type { AgentEvent, CompletionChunk, LLMProvider, StoredMessage } from '@ethosagent/types';
import { createTestSafety } from '../../../../../packages/core/src/__tests__/helpers/test-safety';
import { createPluginActivator } from '../../activator';
import { fixtureDir, type Harness } from './harness';

/** Round 1 calls `tool` with `{}`; round 2 answers `finalText`. */
export function scriptedLLM(tool: string, finalText: string): LLMProvider {
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
        yield { type: 'tool_use_start', toolCallId: 't1', toolName: tool };
        yield { type: 'tool_use_end', toolCallId: 't1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: finalText };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

/** Activates a fixture through the pool and replays its registrations into `tools`/`hooks`. */
export async function activateInto(
  harness: Harness,
  id: string,
  fixture: string,
  tools: DefaultToolRegistry,
  hooks: DefaultHookRegistry,
): Promise<void> {
  const plugin = await createPluginActivator(harness.pool).activate({
    id,
    dir: fixtureDir(fixture),
    entry: '',
    manifest: {},
    tier: 'untrusted',
  });
  await plugin.activate(
    new PluginApiImpl(id, {
      tools,
      hooks,
      injectors: [],
      injectorPluginIds: new Map(),
      personalities: {} as never,
      llmProviders: {} as never,
      memoryProviders: {} as never,
    }),
  );
}

export interface RunTurnOptions {
  pluginId: string;
  fixture: string;
  /** The tool the scripted provider calls in round 1. */
  tool: string;
  finalText: string;
  sessionKey: string;
  /** Registers extra (in-process) tools before the turn runs. */
  extraTools?: (tools: DefaultToolRegistry) => void;
}

/** One real AgentLoop turn over a hosted plugin, drained to exhaustion. */
export async function runTurn(
  harness: Harness,
  opts: RunTurnOptions,
): Promise<{ events: AgentEvent[]; session: InMemorySessionStore }> {
  const tools = new DefaultToolRegistry();
  const hooks = new DefaultHookRegistry();
  await activateInto(harness, opts.pluginId, opts.fixture, tools, hooks);
  opts.extraTools?.(tools);
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'p', name: 'p', description: 'p', plugins: [opts.pluginId] });
  personalities.setDefault('p');
  const session = new InMemorySessionStore();
  const loop = new AgentLoop({
    llm: scriptedLLM(opts.tool, opts.finalText),
    tools,
    hooks,
    personalities,
    session,
    safety: createTestSafety(),
  });
  const events: AgentEvent[] = [];
  // Drain to exhaustion (agent-loop.md: done is the answer, not the end of the turn).
  for await (const e of loop.run('go', { sessionKey: opts.sessionKey, roomAudience: 'private' })) {
    events.push(e);
  }
  return { events, session };
}

/** The persisted tool_result messages of a session. */
export async function toolResults(
  session: InMemorySessionStore,
  sessionKey: string,
): Promise<StoredMessage[]> {
  const stored = await session.getSessionByKey(sessionKey);
  return (await session.getMessages(stored?.id ?? '')).filter((m) => m.role === 'tool_result');
}
