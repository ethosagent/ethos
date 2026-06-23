import type { ContextEngineStore, Message, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { TieredSummaryEngine } from '../context-engines/tiered-summary';

const personality = (overrides: Partial<PersonalityConfig> = {}): PersonalityConfig => ({
  id: 'engineer',
  name: 'Engineer',
  ...overrides,
});

const sessionMetadata = { sessionId: 's', sessionKey: 'cli:s', turnNumber: 0 };

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: text };
}

describe('TieredSummaryEngine', () => {
  it('returns unchanged when under budget', async () => {
    const engine = new TieredSummaryEngine();
    const messages = [userMsg('hi'), assistantMsg('hello')];
    const result = await engine.compact({
      messages,
      currentSystem: 'system',
      targetTokens: 10_000,
      personality: personality(),
      sessionMetadata,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.notes).toMatch(/nothing to summarize|no compaction/);
  });

  it('summarizes middle and pages to store when both handles available', async () => {
    const stored = new Map<string, string>();
    const store: ContextEngineStore = {
      read: async (key) => stored.get(key) ?? null,
      write: async (key, value) => {
        stored.set(key, value);
      },
      list: async () => [...stored.keys()],
    };

    const engine = new TieredSummaryEngine();
    const big = 'x'.repeat(400);
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) messages.push(userMsg(`turn ${i}: ${big}`));

    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 1000,
      personality: personality({ context_engine_options: { preserve_first_n_turns: 1 } }),
      sessionMetadata,
      llm: { summarize: async (mid) => `summary of ${mid.length} messages` },
      store,
    });

    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.summaryText).toBe('summary of 13 messages');
    // Middle was paged to store
    expect(stored.size).toBe(1);
    expect(stored.has('paged-0')).toBe(true);
  });

  it('falls back to placeholder summary when no llm handle', async () => {
    const engine = new TieredSummaryEngine();
    const big = 'x'.repeat(400);
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) messages.push(userMsg(`m${i} ${big}`));

    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 500,
      personality: personality(),
      sessionMetadata,
    });

    expect(result.summaryText).toContain('[summary]');
    expect(result.summaryText).toContain('elided');
  });

  it('records removed[], summaries[], externalWrites[] correctly', async () => {
    const stored = new Map<string, string>();
    const store: ContextEngineStore = {
      read: async (key) => stored.get(key) ?? null,
      write: async (key, value) => {
        stored.set(key, value);
      },
      list: async () => [...stored.keys()],
    };

    const engine = new TieredSummaryEngine();
    const big = 'x'.repeat(400);
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) messages.push(userMsg(`t${i} ${big}`));

    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 500,
      personality: personality({ context_engine_options: { preserve_first_n_turns: 2 } }),
      sessionMetadata: { ...sessionMetadata, turnNumber: 5 },
      llm: { summarize: async (mid) => `summary of ${mid.length}` },
      store,
    });

    // removed entries for every middle message, reason 'summarized' because llm is present
    expect(result.removed).toBeDefined();
    expect(result.removed?.length).toBeGreaterThan(0);
    for (const r of result.removed ?? []) {
      expect(r.reason).toBe('summarized');
      expect(r.index).toBeGreaterThanOrEqual(2);
    }

    // summaries with sourceRange covering the middle
    expect(result.summaries).toHaveLength(1);
    const summary = result.summaries?.[0];
    expect(summary?.sourceRange[0]).toBe(2);
    expect(summary?.sourceRange[1]).toBe(14);

    // externalWrites from the store
    expect(result.externalWrites).toHaveLength(1);
    expect(result.externalWrites?.[0]?.key).toBe('paged-5');
    expect(stored.has('paged-5')).toBe(true);
  });

  it('sets cacheAnchor and cacheBreakpoints', async () => {
    const engine = new TieredSummaryEngine();
    const big = 'x'.repeat(400);
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) messages.push(userMsg(`t${i} ${big}`));

    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 500,
      personality: personality({ context_engine_options: { preserve_first_n_turns: 2 } }),
      sessionMetadata,
    });

    // cacheAnchor = front.length (the summary message index)
    expect(result.cacheAnchor).toBe(2);
    // cacheBreakpoints: end of front (1), then summary message (2)
    expect(result.cacheBreakpoints).toEqual([1, 2]);
  });

  it('uses countTokens for precise measurement when available', async () => {
    const engine = new TieredSummaryEngine();
    const messages = [
      userMsg('a'),
      userMsg('b'),
      userMsg('c'),
      userMsg('d'),
      userMsg('e'),
      userMsg('f'),
      userMsg('g'),
      userMsg('h'),
      userMsg('i'),
      userMsg('j'),
    ];

    let countTokensCalled = false;
    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 500,
      personality: personality(),
      sessionMetadata,
      countTokens: async (_msgs) => {
        countTokensCalled = true;
        // Return a very large number to force compaction
        return 10_000;
      },
    });

    expect(countTokensCalled).toBe(true);
    // Compaction should have happened since countTokens returned 10k > 500
    expect(result.summaryText).toBeDefined();
  });

  it('shouldCompact returns true above 75% threshold', () => {
    const engine = new TieredSummaryEngine();
    const big = 'x'.repeat(400); // ~100 tokens each

    // 10 messages at ~100 tokens = ~1000 tokens; target 1000 → 100% > 75%
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) messages.push(userMsg(big));

    expect(
      engine.shouldCompact({
        messages,
        currentSystem: '',
        targetTokens: 1000,
        personality: personality(),
        sessionMetadata,
      }),
    ).toBe(true);

    // Very small messages, large target → below 75%
    expect(
      engine.shouldCompact({
        messages: [userMsg('hi')],
        currentSystem: '',
        targetTokens: 10_000,
        personality: personality(),
        sessionMetadata,
      }),
    ).toBe(false);
  });

  it('marks removed reason as paged_out when store available but no llm', async () => {
    const stored = new Map<string, string>();
    const store: ContextEngineStore = {
      read: async (key) => stored.get(key) ?? null,
      write: async (key, value) => {
        stored.set(key, value);
      },
      list: async () => [...stored.keys()],
    };

    const engine = new TieredSummaryEngine();
    const big = 'x'.repeat(400);
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) messages.push(userMsg(`t${i} ${big}`));

    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 500,
      personality: personality(),
      sessionMetadata,
      store,
    });

    for (const r of result.removed ?? []) {
      expect(r.reason).toBe('paged_out');
    }
  });

  it('marks removed reason as trimmed when neither llm nor store available', async () => {
    const engine = new TieredSummaryEngine();
    const big = 'x'.repeat(400);
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) messages.push(userMsg(`t${i} ${big}`));

    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 500,
      personality: personality(),
      sessionMetadata,
    });

    for (const r of result.removed ?? []) {
      expect(r.reason).toBe('trimmed');
    }
  });
});
