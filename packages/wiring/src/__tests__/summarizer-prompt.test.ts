import type { Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  buildSummarizerSystemPrompt,
  capSummary,
  renderMiddleForSummary,
  SUMMARIZER_SYSTEM_PROMPT,
} from '../summarizer-prompt';

describe('SUMMARIZER_SYSTEM_PROMPT', () => {
  it('demands the structured handoff headings', () => {
    for (const heading of [
      '## Open task / goal',
      '## Decisions made',
      '## Files touched',
      '## Identifiers introduced',
      '## Tool outcomes',
      '## Open questions / blockers',
    ]) {
      expect(SUMMARIZER_SYSTEM_PROMPT).toContain(heading);
    }
  });

  it('locks down verbatim preservation and language preservation', () => {
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain('CHARACTER-FOR-CHARACTER');
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain('SAME LANGUAGE');
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain('VERBATIM');
  });
});

describe('buildSummarizerSystemPrompt (Phase 2 — /compact focus)', () => {
  it('returns the base prompt unchanged when there is no focus', () => {
    expect(buildSummarizerSystemPrompt()).toBe(SUMMARIZER_SYSTEM_PROMPT);
    expect(buildSummarizerSystemPrompt('   ')).toBe(SUMMARIZER_SYSTEM_PROMPT);
  });

  it('appends the focus directive without dropping the base rules', () => {
    const out = buildSummarizerSystemPrompt('the deploy debugging');
    expect(out).toContain(SUMMARIZER_SYSTEM_PROMPT);
    expect(out).toContain('## Focus');
    expect(out).toContain('the deploy debugging');
    expect(out).toContain('never drop file paths, identifiers, or error strings');
  });
});

describe('renderMiddleForSummary', () => {
  it('renders string content with role headers', () => {
    const middle: Message[] = [
      { role: 'user', content: 'read packages/core/src/agent-loop.ts' },
      { role: 'assistant', content: 'done' },
    ];
    const rendered = renderMiddleForSummary(middle);
    expect(rendered).toContain('### user');
    expect(rendered).toContain('packages/core/src/agent-loop.ts');
    expect(rendered).toContain('### assistant');
  });

  it('renders tool_use and tool_result blocks explicitly', () => {
    const middle: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/tmp/x' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ENOENT', is_error: true }],
      },
    ];
    const rendered = renderMiddleForSummary(middle);
    expect(rendered).toContain('[tool_use read_file]');
    expect(rendered).toContain('"path":"/tmp/x"');
    expect(rendered).toContain('[tool_result error] ENOENT');
  });
});

describe('capSummary', () => {
  it('returns the text unchanged when under budget', () => {
    const text = 'A short summary.';
    expect(capSummary(text, 100)).toBe(text);
  });

  it('truncates at a sentence boundary when over budget', () => {
    // Budget: 5 tokens → 20 chars. Two sentences, second overflows.
    const text = 'First sentence here. Second sentence is much longer and overflows.';
    const capped = capSummary(text, 5);
    expect(capped.length).toBeLessThan(text.length);
    expect(capped).toContain('First sentence here.');
    expect(capped).toContain('[summary truncated to fit budget]');
    expect(capped).not.toContain('overflows');
  });

  it('hard-truncates when no sentence boundary fits the budget', () => {
    const text = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const capped = capSummary(text, 4); // 16 char budget, no punctuation
    expect(capped).toContain('[summary truncated to fit budget]');
    expect(capped.startsWith('aaaa')).toBe(true);
  });
});
