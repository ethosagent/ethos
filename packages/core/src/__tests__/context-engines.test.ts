import type { Message, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DropOldestEngine } from '../context-engines/drop-oldest';
import { ReferencePreservingEngine } from '../context-engines/reference-preserving';
import { DefaultContextEngineRegistry } from '../context-engines/registry';
import { SemanticSummaryEngine } from '../context-engines/semantic-summary';

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

describe('DropOldestEngine', () => {
  it('returns input unchanged when already under target', async () => {
    const engine = new DropOldestEngine();
    const messages = [userMsg('hi'), assistantMsg('hello')];
    const result = await engine.compact({
      messages,
      currentSystem: 'system',
      targetTokens: 1000,
      personality: personality(),
      sessionMetadata,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.notes).toContain('no compaction');
  });

  it('drops oldest until under budget', async () => {
    const engine = new DropOldestEngine();
    const big = 'x'.repeat(400); // ~100 tokens
    const messages = [userMsg(big), userMsg(big), userMsg(big), userMsg(big)];
    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 200, // ~800 chars budget; one message takes 400
      personality: personality(),
      sessionMetadata,
    });
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.notes).toContain('dropped');
  });

  it('preserves first N turns when configured', async () => {
    const engine = new DropOldestEngine();
    const big = 'x'.repeat(400);
    const messages = [userMsg(`task: ${big}`), userMsg(big), userMsg(big), userMsg(big)];
    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 200,
      personality: personality({ context_engine_options: { preserve_first_n_turns: 1 } }),
      sessionMetadata,
    });
    // First message must survive
    expect(typeof result.messages[0]?.content === 'string' && result.messages[0].content).toContain(
      'task:',
    );
  });
});

describe('SemanticSummaryEngine', () => {
  it('returns input unchanged when nothing to summarize', async () => {
    const engine = new SemanticSummaryEngine();
    const result = await engine.compact({
      messages: [userMsg('hello')],
      currentSystem: '',
      targetTokens: 1000,
      personality: personality(),
      sessionMetadata,
    });
    expect(result.notes).toMatch(/nothing to summarize|no compaction/);
  });

  it('inserts a summary message in the middle when under pressure', async () => {
    const summaries: number[] = [];
    const engine = new SemanticSummaryEngine({
      summarize: async (middle) => {
        summaries.push(middle.length);
        return `summary of ${middle.length} messages`;
      },
    });
    const big = 'x'.repeat(400);
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) messages.push(userMsg(`turn ${i}: ${big}`));
    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 1000,
      personality: personality({ context_engine_options: { preserve_first_n_turns: 1 } }),
      sessionMetadata,
    });
    expect(summaries.length).toBe(1);
    expect(result.messages.length).toBeLessThan(messages.length);
    // Summary should appear right after the preserved front
    const second = result.messages[1];
    if (second && Array.isArray(second.content)) {
      const block = second.content[0];
      expect(block).toMatchObject({ type: 'text' });
    }
    // F3 — the summary text is surfaced for persistence.
    expect(result.summaryText).toBe('summary of 13 messages');
    // F2 — cache breakpoints at the end of the preserved front and the
    // summary message (preserve_first_n_turns: 1 → indices 0 and 1).
    expect(result.cacheBreakpoints).toEqual([0, 1]);
  });

  it('falls back to placeholder summary when no summarizer is wired', async () => {
    const engine = new SemanticSummaryEngine();
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
    expect(result.notes).toContain('summarized');
  });
});

describe('ReferencePreservingEngine', () => {
  it('drops prose without references first', async () => {
    const engine = new ReferencePreservingEngine();
    const messages = [
      userMsg('I was thinking about our project today and wondering how it all fits together'),
      userMsg('Look at packages/core/src/agent-loop.ts to understand the flow'),
      userMsg('More chatty prose without any code references whatsoever in this message'),
      userMsg('Also worth checking extensions/skills/src/ingest-filter.ts for the gate'),
      // Tail kept regardless
      userMsg('one'),
      userMsg('two'),
      userMsg('three'),
      userMsg('four'),
    ];
    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 50,
      personality: personality(),
      sessionMetadata,
    });
    const allText = result.messages.map((m) => (typeof m.content === 'string' ? m.content : ''));
    // The newest reference-bearing message survives; both prose-only ones drop first.
    expect(allText.some((t) => t.includes('ingest-filter.ts'))).toBe(true);
    expect(allText.some((t) => t.includes('chatty prose without'))).toBe(false);
    expect(allText.some((t) => t.includes('about our project today'))).toBe(false);
  });
});

describe('DefaultContextEngineRegistry', () => {
  it('ships drop_oldest, semantic_summary, reference_preserving, tiered_summary by default', () => {
    const reg = new DefaultContextEngineRegistry();
    expect(reg.names().sort()).toEqual(
      ['drop_oldest', 'reference_preserving', 'semantic_summary', 'tiered_summary'].sort(),
    );
  });

  it('returns undefined for unknown names', () => {
    const reg = new DefaultContextEngineRegistry();
    expect(reg.get('made-up-name')).toBeUndefined();
  });

  it('accepts plugin-registered engines', () => {
    const reg = new DefaultContextEngineRegistry();
    reg.register({
      name: 'custom',
      compact: async () => ({ messages: [], notes: 'custom' }),
    });
    expect(reg.get('custom')?.name).toBe('custom');
  });
});
