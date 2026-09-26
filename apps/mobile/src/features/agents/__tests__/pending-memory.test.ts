import { describe, expect, it } from 'vitest';
import { isResolved, pendingDetail, pendingRow, pendingText } from '../pending-memory';

const at = new Date(2026, 8, 27, 9, 39).getTime();

describe('pendingRow', () => {
  it('reads ⚠ proposed · file · action · "content" · time', () => {
    const row = pendingRow({
      id: '1',
      update: { action: 'add', key: 'MEMORY.md', content: 'prefers\n  pnpm' },
      source: 'capture',
      proposedAt: at,
    });
    expect(row).toEqual({
      glyph: '⚠',
      word: 'proposed',
      subject: 'MEMORY.md · add',
      result: '"prefers pnpm"',
      time: '09:39',
    });
  });

  it('truncates a long write', () => {
    const row = pendingRow({
      id: '1',
      update: { action: 'replace', key: 'USER.md', content: 'x'.repeat(200) },
      source: 'tool',
      proposedAt: at,
    });
    expect(row.result?.length).toBe(62);
    expect(row.result?.endsWith('…"')).toBe(true);
  });

  it('a delete has no quoted content', () => {
    const row = pendingRow({
      id: '1',
      update: { action: 'delete', key: 'notes.md' },
      source: 'tool',
      proposedAt: at,
    });
    expect(row.result).toBeUndefined();
  });
});

describe('pendingText / pendingDetail', () => {
  it('a remove shows the substring it removes', () => {
    expect(pendingText({ action: 'remove', key: 'USER.md', substringMatch: 'old' })).toBe('old');
  });

  it('lists store, action and origin', () => {
    expect(
      pendingDetail({
        id: '1',
        update: { action: 'add', key: 'MEMORY.md', content: 'x' },
        source: 'capture',
        sessionId: 's1',
        proposedAt: at,
      }),
    ).toEqual([
      { key: 'store', value: 'MEMORY.md' },
      { key: 'action', value: 'add' },
      { key: 'from', value: 'capture · s1' },
    ]);
  });
});

describe('isResolved', () => {
  const list = [
    { id: 'a', update: { action: 'delete' as const, key: 'k' }, source: 't', proposedAt: at },
  ];
  it('is resolved only once a loaded list drops the id', () => {
    expect(isResolved(undefined, 'a')).toBe(false);
    expect(isResolved(list, 'a')).toBe(false);
    expect(isResolved([], 'a')).toBe(true);
  });
});
