import type { StoredMessage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { formatRecap } from '../lib/recap';

// ---------------------------------------------------------------------------
// FW-6 — recap panel formatter
// ---------------------------------------------------------------------------

function makeMsg(role: 'user' | 'assistant', content: string, n = 0): StoredMessage {
  return {
    id: `msg-${n}`,
    sessionId: 'sess-1',
    role,
    content,
    timestamp: new Date(),
  };
}

describe('formatRecap', () => {
  it('returns null for empty message list', () => {
    expect(formatRecap([])).toBeNull();
  });

  it('returns null when turns is 0', () => {
    const msgs = [makeMsg('user', 'hello', 0), makeMsg('assistant', 'hi', 1)];
    expect(formatRecap(msgs, { turns: 0 })).toBeNull();
  });

  it('renders a box with header and last N turn pairs', () => {
    const msgs = [
      makeMsg('user', 'first question', 0),
      makeMsg('assistant', 'first answer', 1),
      makeMsg('user', 'second question', 2),
      makeMsg('assistant', 'second answer', 3),
    ];
    const result = formatRecap(msgs, { turns: 2 });
    expect(result).not.toBeNull();
    const joined = result?.lines.join('\n') ?? '';
    expect(joined).toContain('Previous conversation');
    expect(joined).toContain('You: first question');
    expect(joined).toContain('Agent: second answer');
  });

  it('shows only the last N turn pairs when session has more', () => {
    const msgs = [
      makeMsg('user', 'old question', 0),
      makeMsg('assistant', 'old answer', 1),
      makeMsg('user', 'recent question', 2),
      makeMsg('assistant', 'recent answer', 3),
      makeMsg('user', 'newest question', 4),
      makeMsg('assistant', 'newest answer', 5),
    ];
    const result = formatRecap(msgs, { turns: 1 });
    expect(result).not.toBeNull();
    const joined = result?.lines.join('\n') ?? '';
    expect(joined).toContain('newest question');
    expect(joined).toContain('newest answer');
    expect(joined).not.toContain('old question');
  });

  it('truncates long messages with ellipsis', () => {
    const longContent = 'a'.repeat(200);
    const msgs = [makeMsg('user', longContent, 0), makeMsg('assistant', 'short', 1)];
    const result = formatRecap(msgs, { turns: 1, lineWidth: 80 });
    expect(result).not.toBeNull();
    const userLine = result?.lines.find((l) => l.includes('You:')) ?? '';
    expect(userLine.length).toBeLessThanOrEqual(82); // 80 + '│ ' + ' │'
    expect(userLine).toContain('…');
  });

  it('does not split multi-byte characters at truncation boundary', () => {
    // Multi-byte: each emoji is 2 chars wide but 4 bytes
    const emoji = '😀'.repeat(50);
    const msgs = [makeMsg('user', emoji, 0), makeMsg('assistant', 'ok', 1)];
    const result = formatRecap(msgs, { turns: 1, lineWidth: 80 });
    expect(result).not.toBeNull();
    // Should not throw and should contain valid truncation marker
    const userLine = result?.lines.find((l) => l.includes('You:')) ?? '';
    expect(userLine).toContain('…');
  });

  it('ignores tool_result and system messages', () => {
    const msgs: StoredMessage[] = [
      makeMsg('user', 'user message', 0),
      { ...makeMsg('assistant', 'assistant msg', 1), role: 'tool_result' },
      makeMsg('assistant', 'final answer', 2),
    ];
    const result = formatRecap(msgs, { turns: 1 });
    const joined = result?.lines.join('\n') ?? '';
    expect(joined).not.toContain('tool_result');
    expect(joined).toContain('final answer');
  });
});
