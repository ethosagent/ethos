// S12 (plan openclaw-2026.9.6-gaps): a tool that starts a sub-agent turn
// (`delegate_task`) must be able to hand the child the parent turn's tool
// narrowing, or the child regains the full personality toolset. The turn's
// effective allowlist and surface exclusion reach the tool as
// `ToolContext.toolsetNarrowing`, set in `processTools`
// (`../stages/tool-processing.ts`).

import type {
  CompletionChunk,
  LLMProvider,
  PersonalityConfig,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../__tests__/helpers/test-safety';
import { AgentLoop, type RunOptions } from '../../agent-loop';
import { InMemorySessionStore } from '../../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../../defaults/noop-personality';
import { DefaultHookRegistry } from '../../hook-registry';
import { DefaultToolRegistry } from '../../tool-registry';

function oneToolLLM(toolName: string): LLMProvider {
  let round = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      round++;
      if (round > 1) {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      yield { type: 'tool_use_start', toolCallId: 'call-1', toolName };
      yield { type: 'tool_use_end', toolCallId: 'call-1', inputJson: '{}' };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function ctxSeenBy(
  personality: PersonalityConfig,
  opts: Pick<RunOptions, 'toolsetNarrow' | 'toolsetExclude' | 'toolsetOverride'>,
): Promise<ToolContext | undefined> {
  let seen: ToolContext | undefined;
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'delegate_task',
    description: 'probe',
    schema: { type: 'object' },
    capabilities: {},
    toolset: 'delegation',
    async execute(_args, ctx): Promise<ToolResult> {
      seen = ctx;
      return { ok: true, value: 'ok' };
    },
  });
  const personalities = new DefaultPersonalityRegistry();
  personalities.define(personality);
  const loop = new AgentLoop({
    llm: oneToolLLM('delegate_task'),
    tools,
    hooks: new DefaultHookRegistry(),
    session: new InMemorySessionStore(),
    personalities,
    safety: createTestSafety(),
  });
  for await (const _ of loop.run('go', {
    sessionKey: 'narrow',
    personalityId: personality.id,
    ...opts,
  })) {
    // drain
  }
  return seen;
}

describe('ToolContext.toolsetNarrowing', () => {
  it("carries the turn's effective allowlist and its surface exclusion", async () => {
    const ctx = await ctxSeenBy(
      { id: 'p', name: 'P', toolset: ['delegate_task', 'read_file', 'terminal'] },
      { toolsetNarrow: ['delegate_task', 'read_file'], toolsetExclude: ['send_message'] },
    );
    expect(ctx?.toolsetNarrowing).toEqual({
      narrow: ['delegate_task', 'read_file'],
      exclude: ['send_message'],
    });
  });

  it('carries a toolsetOverride as the allowlist', async () => {
    const ctx = await ctxSeenBy(
      { id: 'p', name: 'P', toolset: ['delegate_task', 'terminal'] },
      { toolsetOverride: ['delegate_task'] },
    );
    expect(ctx?.toolsetNarrowing).toEqual({ narrow: ['delegate_task'] });
  });

  it('is absent when the turn has no allowlist and no exclusion', async () => {
    const ctx = await ctxSeenBy({ id: 'p', name: 'P' }, {});
    expect(ctx).toBeDefined();
    expect(ctx?.toolsetNarrowing).toBeUndefined();
  });
});
