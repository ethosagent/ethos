// Context-economy Phase 2 (§3.4.1) — standing-instruction survival through
// compaction. The unit-level gate for the eval-gated autoCompact flip: durable
// user directives in the summarized middle must be carried forward VERBATIM,
// not merely mentioned inside the summary.

import type { Message, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { maybeCompact } from '../agent-loop/compaction';
import { DefaultContextEngineRegistry } from '../context-engines/registry';
import { SemanticSummaryEngine } from '../context-engines/semantic-summary';
import { isStandingInstruction } from '../context-engines/standing-instructions';
import { TieredSummaryEngine } from '../context-engines/tiered-summary';

const personality = (overrides: Partial<PersonalityConfig> = {}): PersonalityConfig => ({
  id: 'test',
  name: 'Test',
  ...overrides,
});

const sessionMetadata = { sessionId: 's', sessionKey: 'cli:s', turnNumber: 1 };

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: text };
}

function messageTexts(messages: Message[]): string[] {
  return messages.map((m) =>
    typeof m.content === 'string'
      ? m.content
      : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
  );
}

/** 50+ synthetic messages with the given extras spliced into the middle. */
function longHistory(extras: Array<{ index: number; message: Message }>): Message[] {
  const filler = 'x'.repeat(400);
  const messages: Message[] = [];
  for (let i = 0; i < 52; i++) {
    messages.push(
      i % 2 === 0 ? userMsg(`turn ${i}: ${filler}`) : assistantMsg(`reply ${i}: ${filler}`),
    );
  }
  for (const { index, message } of extras) messages[index] = message;
  return messages;
}

const DIRECTIVE = 'From now on, always end your replies with the word ORCHID.';

describe('isStandingInstruction heuristic', () => {
  it('matches explicit pins regardless of phrasing', () => {
    expect(isStandingInstruction('[pin] the codename is BLUE-HERON-7')).toBe(true);
    expect(isStandingInstruction('PIN: remember the deploy window')).toBe(true);
    expect(isStandingInstruction('  [Pin] leading whitespace ok')).toBe(true);
  });

  it('matches short imperative + durable-scope messages, case-insensitively', () => {
    expect(isStandingInstruction(DIRECTIVE)).toBe(true);
    expect(isStandingInstruction('NEVER push to main without asking.')).toBe(true);
    expect(isStandingInstruction('Going forward, use pnpm not npm.')).toBe(true);
    expect(isStandingInstruction('every time you finish, run the linter')).toBe(true);
  });

  it('rejects plain conversation and long content that merely contains a marker', () => {
    expect(isStandingInstruction('what is the weather today?')).toBe(false);
    expect(isStandingInstruction('')).toBe(false);
    // >500 chars containing "always" is content, not a directive.
    expect(isStandingInstruction(`${'y'.repeat(600)} always ${'y'.repeat(600)}`)).toBe(false);
    // …but an explicit pin qualifies at any length.
    expect(isStandingInstruction(`[pin] ${'y'.repeat(1200)}`)).toBe(true);
  });
});

describe('SemanticSummaryEngine — standing-instruction survival', () => {
  it('carries the directive verbatim ahead of the summary and excludes it from the summarizer input', async () => {
    const summarizerInputs: Message[][] = [];
    const engine = new SemanticSummaryEngine({
      summarize: async (middle) => {
        summarizerInputs.push(middle);
        return 'condensed summary';
      },
    });
    const messages = longHistory([{ index: 25, message: userMsg(DIRECTIVE) }]);
    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 1000,
      personality: personality(),
      sessionMetadata,
    });

    const texts = messageTexts(result.messages);
    // Verbatim survival — the directive is a real message, not summary prose.
    expect(texts).toContain(DIRECTIVE);
    // It sits ahead of the summary: front(1) + directive, then the summary.
    expect(texts[1]).toBe(DIRECTIVE);
    expect(texts[2]).toBe('condensed summary');
    expect(result.summaryText).toBe('condensed summary');
    // The summarizer never saw the directive.
    expect(summarizerInputs).toHaveLength(1);
    expect(messageTexts(summarizerInputs[0] ?? [])).not.toContain(DIRECTIVE);
    // Non-directive middle messages were summarized away.
    expect(texts.some((t) => t.startsWith('turn 10:'))).toBe(false);
    // Cache breakpoints track the shifted summary index (front=1, carried=1).
    expect(result.cacheBreakpoints).toEqual([0, 2]);
  });

  it('preserves the directive on the deterministic fallback path (no summarizer wired)', async () => {
    const engine = new SemanticSummaryEngine();
    const messages = longHistory([{ index: 25, message: userMsg(DIRECTIVE) }]);
    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 1000,
      personality: personality(),
      sessionMetadata,
    });
    const texts = messageTexts(result.messages);
    expect(texts).toContain(DIRECTIVE);
    expect(result.summaryText).toContain('[summary]');
  });

  it('preserves a [pin]-prefixed message regardless of phrasing', async () => {
    const pinned = '[pin] deploy codename is BLUE-HERON-7';
    const engine = new SemanticSummaryEngine({ summarize: async () => 'S' });
    const messages = longHistory([{ index: 21, message: userMsg(pinned) }]);
    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 1000,
      personality: personality(),
      sessionMetadata,
    });
    expect(messageTexts(result.messages)).toContain(pinned);
  });

  it('dedupes repeated directives — carried once', async () => {
    const engine = new SemanticSummaryEngine({ summarize: async () => 'S' });
    const messages = longHistory([
      { index: 15, message: userMsg(DIRECTIVE) },
      { index: 31, message: userMsg(DIRECTIVE) },
    ]);
    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 1000,
      personality: personality(),
      sessionMetadata,
    });
    const texts = messageTexts(result.messages);
    expect(texts.filter((t) => t === DIRECTIVE)).toHaveLength(1);
  });
});

describe('TieredSummaryEngine — standing-instruction survival', () => {
  it('carries the directive verbatim and emits no removed entry for it', async () => {
    const engine = new TieredSummaryEngine();
    const messages = longHistory([{ index: 25, message: userMsg(DIRECTIVE) }]);
    const result = await engine.compact({
      messages,
      currentSystem: '',
      targetTokens: 1000,
      personality: personality(),
      sessionMetadata,
      llm: { summarize: async () => 'tiered summary' },
    });
    const texts = messageTexts(result.messages);
    expect(texts).toContain(DIRECTIVE);
    // The carried directive (original index 25) is NOT among the removed.
    expect(result.removed?.some((r) => r.index === 25)).toBe(false);
  });
});

describe('compaction trigger — directive survives the real maybeCompact pipeline', () => {
  it('fires past the pressure gate and the directive survives in the compacted history', async () => {
    const registry = new DefaultContextEngineRegistry();
    const sessionMock = {
      recordCompression: async () => ({}),
      updateUsage: async () => {},
      recordCompactionTurn: async () => {},
      // biome-ignore lint/suspicious/noExplicitAny: standard test mock
    } as any;

    const messages = longHistory([{ index: 25, message: userMsg(DIRECTIVE) }]);
    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 2000 } as any,
        contextEngines: registry,
        session: sessionMock,
      },
      messages,
      '',
      personality({ context_engine: 'semantic_summary' }),
      { sessionId: 's1', sessionKey: 'cli:s1', turnNumber: 1, lastCompactionTurn: 0 },
    );

    // The gate fired (compaction actually triggered at threshold)…
    expect(result.notice).toBeDefined();
    expect(result.messages.length).toBeLessThan(messages.length);
    // …and the standing instruction survived verbatim.
    expect(messageTexts(result.messages)).toContain(DIRECTIVE);
  });
});
