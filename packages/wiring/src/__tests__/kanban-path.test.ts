import { describe, expect, it } from 'vitest';
import { resolveKanbanDbPath } from '../kanban-path';

describe('resolveKanbanDbPath', () => {
  it('falls back to the global board when no team or override is set', () => {
    expect(resolveKanbanDbPath({}, '/data')).toBe('/data/board.db');
  });

  it('routes to the team board when teamName is set', () => {
    expect(resolveKanbanDbPath({ teamName: 'analytics' }, '/data')).toBe(
      '/data/teams/analytics/board.db',
    );
  });

  it('honours explicit kanbanDbPath above team and global fallbacks', () => {
    expect(
      resolveKanbanDbPath({ kanbanDbPath: '/custom/board.db', teamName: 'analytics' }, '/data'),
    ).toBe('/custom/board.db');
  });
});
