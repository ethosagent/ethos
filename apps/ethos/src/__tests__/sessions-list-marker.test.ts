import { describe, expect, it } from 'vitest';
import {
  currentCliSessionKey,
  formatSessionListLines,
  type SessionListItem,
} from '../commands/sessions';

// C4 (plan ux-feedback-and-config-clarity) — `sessions list` marks the row of
// the current CLI session (`cli:<cwd-basename>`, the chat session-key
// convention) with `*`.

function item(id: string, key: string): SessionListItem {
  return { id, key, messageCount: 1, updatedAt: new Date('2026-09-26T10:00:00Z') };
}

describe('currentCliSessionKey', () => {
  it('is cli:<cwd-basename>', () => {
    expect(currentCliSessionKey('/Users/x/personal/ethos')).toBe('cli:ethos');
  });
});

describe('formatSessionListLines', () => {
  it('marks the current session row with * and no other', () => {
    const lines = formatSessionListLines(
      [item('aaa', 'cli:ethos'), item('bbb', 'cli:other'), item('ccc', 'cli:ethos:1727000000')],
      'cli:ethos',
    );
    const rows = lines.slice(2);
    expect(rows[0]?.startsWith('* aaa')).toBe(true);
    expect(rows[1]?.startsWith('  bbb')).toBe(true);
    // A /new session's timestamped key is a different session, not the
    // current one.
    expect(rows[2]?.startsWith('  ccc')).toBe(true);
  });
});
