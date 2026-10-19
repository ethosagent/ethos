// video_analyze reports the provider's own cost as `cost_usd`, the way
// vision_analyze does (./vision.test.ts). Core persists a tool's `cost_usd` on
// its tool_result message row and charges the session
// (packages/core/src/agent-loop/tool-cost.ts), so the tool's provider is never
// metered (plan background-usage-accounting D9/D17) — without this the call's
// spend was lost entirely.

import type { CompletionChunk, LLMProvider, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createVideoAnalyzeTool } from '../video';

function usage(cost: number): CompletionChunk {
  return {
    type: 'usage',
    usage: {
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: cost,
    },
  };
}

const provider: LLMProvider = {
  name: 'stub',
  model: 'claude-sonnet-4-6',
  maxContextTokens: 200_000,
  supportsCaching: false,
  supportsThinking: false,
  async *complete(): AsyncIterable<CompletionChunk> {
    yield { type: 'text_delta', text: 'a cat walks across a keyboard' };
    yield usage(0.02);
    yield usage(0.005);
    yield { type: 'done', finishReason: 'end_turn' };
  },
  async countTokens() {
    return 0;
  },
};

const ctx = {
  sessionId: 's',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
} as ToolContext;

describe('video_analyze cost', () => {
  it('returns the summed provider cost as cost_usd', async () => {
    const tool = createVideoAnalyzeTool({
      resolveProvider: () => provider,
      defaultModel: 'claude-sonnet-4-6',
    });
    const result = await tool.execute({ file_url: 'https://93.184.216.34/clip.mp4' }, ctx);
    expect(result).toMatchObject({ ok: true, value: 'a cat walks across a keyboard' });
    expect(result.ok && result.cost_usd).toBeCloseTo(0.025, 9);
  });
});
