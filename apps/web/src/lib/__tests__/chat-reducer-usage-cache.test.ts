import { describe, expect, it } from 'vitest';
import { applyEvent, initialChatState } from '../chat-reducer';

// Context size is the whole prompt: fresh input plus both cache buckets
// (promptTokensOf). Kept out of chat-reducer.test.ts, which is size-capped.

const NOW = 1000;

describe('chat-reducer usage event with cache tokens', () => {
  it('sums input + cache read + cache creation into contextTokens', () => {
    const s = applyEvent(
      initialChatState,
      {
        type: 'usage',
        inputTokens: 2000,
        outputTokens: 5,
        estimatedCostUsd: 0,
        cacheReadTokens: 80000,
        cacheCreationTokens: 300,
      },
      NOW,
    );
    expect(s.contextTokens).toBe(82300);
  });

  it('falls back to inputTokens when no cache fields are present', () => {
    const s = applyEvent(
      initialChatState,
      { type: 'usage', inputTokens: 2000, outputTokens: 5, estimatedCostUsd: 0 },
      NOW,
    );
    expect(s.contextTokens).toBe(2000);
  });
});
