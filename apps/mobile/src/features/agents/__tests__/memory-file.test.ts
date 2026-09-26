import { describe, expect, it } from 'vitest';
import { fileLine } from '../memory-file';

describe('fileLine', () => {
  it('shortens the home directory and reports size and mtime', () => {
    const modifiedAt = new Date(2026, 8, 27, 9, 41).toISOString();
    expect(
      fileLine({
        store: 'memory',
        content: 'x'.repeat(2150),
        path: '/Users/me/.ethos/personalities/engineer/memory/MEMORY.md',
        modifiedAt,
      }),
    ).toBe('~/.ethos/personalities/engineer/memory/MEMORY.md · 2.1 KB · updated 09:41');
  });

  it('names the file when the backend has no path, and omits a missing mtime', () => {
    expect(fileLine({ store: 'user', content: '', path: null, modifiedAt: null })).toBe(
      'USER.md · 0 B',
    );
  });
});
