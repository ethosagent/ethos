// V-GC-7 / UBP-050 — one approval-args formatter for every channel card. The
// Slack, Discord and Telegram cards each carried a copy of the same
// redact → stringify → cap rules, free to drift apart; they now all call
// `formatApprovalArgs`, passing their own length limit and fence handling.

import { describe, expect, it } from 'vitest';
import { formatApprovalArgs, TRUNCATED_MARKER, truncateWithMarker } from '../index';

describe('formatApprovalArgs (V-GC-7)', () => {
  it('redacts credentials in values before stringifying', () => {
    const text = formatApprovalArgs(
      { command: 'curl -H "x-api-key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"' },
      { maxChars: 2500 },
    );
    expect(text).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(text.startsWith('{\n  "command"')).toBe(true);
  });

  it('redacts a string arg', () => {
    const text = formatApprovalArgs('token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', {
      maxChars: 2500,
    });
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('caps at the caller-supplied limit with an explicit marker', () => {
    const text = formatApprovalArgs({ content: 'x'.repeat(10_000) }, { maxChars: 100 });
    expect(text).toHaveLength(100 + TRUNCATED_MARKER.length);
    expect(text.endsWith(TRUNCATED_MARKER)).toBe(true);
  });

  it('applies the platform neutralizer before the cap, so the cap holds', () => {
    const zwsp = (run: string) => run.split('').join('​');
    const text = formatApprovalArgs('`'.repeat(200), {
      maxChars: 50,
      neutralize: (t) => t.replace(/`+/g, zwsp),
    });
    expect(text).not.toContain('``');
    expect(text).toHaveLength(50 + TRUNCATED_MARKER.length);
  });

  it('renders missing args and a circular object without throwing', () => {
    expect(formatApprovalArgs(undefined, { maxChars: 2500 })).toBe('(no arguments)');
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => formatApprovalArgs(circular, { maxChars: 2500 })).not.toThrow();
  });

  it('truncateWithMarker leaves short text alone', () => {
    expect(truncateWithMarker('short', 10)).toBe('short');
    expect(truncateWithMarker('0123456789ab', 10)).toBe(`0123456789${TRUNCATED_MARKER}`);
  });
});
