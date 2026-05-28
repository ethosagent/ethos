import { describe, expect, it } from 'vitest';
import { resolveKanbanDbPath } from '../kanban-path';
describe('resolveKanbanDbPath', () => {
    it('falls back to per-personality solo board when no team or override is set', () => {
        expect(resolveKanbanDbPath({}, '/data', 'engineer')).toBe('/data/personalities/engineer/kanban.db');
    });
    it('routes to the team board when teamName is set', () => {
        expect(resolveKanbanDbPath({ teamName: 'analytics' }, '/data', 'engineer')).toBe('/data/teams/analytics/board.db');
    });
    it('honours explicit kanbanDbPath above team and per-personality fallbacks', () => {
        expect(resolveKanbanDbPath({ kanbanDbPath: '/custom/board.db', teamName: 'analytics' }, '/data', 'engineer')).toBe('/custom/board.db');
    });
});
