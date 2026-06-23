import { validateContextEngine } from '@ethosagent/core';
import type { Message, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { CustomContextEngine } from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const personality = (overrides: Partial<PersonalityConfig> = {}): PersonalityConfig => ({
  id: 'test',
  name: 'Test',
  ...overrides,
});

const sessionMetadata = { sessionId: 's', sessionKey: 'cli:s', turnNumber: 0 };

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: text };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CustomContextEngine', () => {
  const engine = new CustomContextEngine();

  it('returns input unchanged when under budget', async () => {
    const messages = [userMsg('hi'), assistantMsg('hello')];
    const result = await engine.compact({
      messages,
      currentSystem: 'system',
      targetTokens: 10000,
      personality: personality(),
      sessionMetadata,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.notes).toContain('no compaction');
  });

  it('compacts when over budget', async () => {
    const big = 'x'.repeat(400); // ~100 tokens each
    const messages: Message[] = [];
    for (let i = 0; i < 12; i++) {
      const msg = i % 2 === 0 ? userMsg(`turn ${i}: ${big}`) : assistantMsg(`reply ${i}: ${big}`);
      messages.push(msg);
    }

    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 500,
      personality: personality(),
      sessionMetadata,
      llm: {
        summarize: async (msgs, _target) => `summary of ${msgs.length} messages`,
      },
    });

    // Output should be shorter than input.
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.summaryText).toContain('summary of');
    expect(result.notes).toContain('summarized');
    // Removed entries should be present.
    expect(result.removed).toBeDefined();
    expect(result.removed?.length).toBeGreaterThan(0);
  });

  it('passes the conformance harness', async () => {
    const result = await validateContextEngine(engine);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });
});
