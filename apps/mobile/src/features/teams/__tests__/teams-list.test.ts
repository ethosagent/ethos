import { describe, expect, it } from 'vitest';
import { attentionTiles, teamRowSubtitle, teamsSubtitle, tileStatusRow } from '../teams-list';

const task = (id: string, status: 'blocked' | 'needs_revision', updatedAt: string) => ({
  id,
  title: id,
  status,
  assignee: 'scout',
  priority: 1,
  updatedAt,
});

describe('teamsSubtitle', () => {
  it('counts stale as stopped', () => {
    expect(teamsSubtitle([{ health: 'running' }, { health: 'stale' }, { health: 'stopped' }])).toBe(
      '1 running · 2 stopped',
    );
  });
});

describe('teamRowSubtitle', () => {
  const base = {
    name: 'marketing',
    memberCount: 4,
    coordinator: 'cmo',
    health: 'running' as const,
  };
  it('carries the attention suffix', () => {
    expect(teamRowSubtitle({ ...base, attentionCount: 2 })).toBe(
      '4 members · cmo · 2 need attention',
    );
    expect(teamRowSubtitle({ ...base, attentionCount: 1 })).toBe(
      '4 members · cmo · 1 needs attention',
    );
  });
  it('drops the suffix at zero and on an older server without the field', () => {
    expect(teamRowSubtitle({ ...base, attentionCount: 0 })).toBe('4 members · cmo');
    expect(teamRowSubtitle(base)).toBe('4 members · cmo');
  });
  it('omits a missing coordinator and singularises', () => {
    expect(teamRowSubtitle({ ...base, memberCount: 1, coordinator: null })).toBe('1 member');
  });
});

describe('attentionTiles', () => {
  it('is null when no team carried the field (older server) — nothing invented', () => {
    expect(
      attentionTiles([{ name: 'a', memberCount: 1, coordinator: null, health: 'running' }]),
    ).toBe(null);
  });
  it('merges every team newest first', () => {
    const tiles = attentionTiles([
      {
        name: 'a',
        memberCount: 1,
        coordinator: null,
        health: 'running',
        attention: [task('t1', 'blocked', '2026-09-01T00:00:00Z')],
      },
      {
        name: 'b',
        memberCount: 1,
        coordinator: null,
        health: 'running',
        attention: [task('t2', 'needs_revision', '2026-09-02T00:00:00Z')],
      },
    ]);
    expect(tiles?.map((t) => [t.team, t.task.id])).toEqual([
      ['b', 't2'],
      ['a', 't1'],
    ]);
  });
});

describe('tileStatusRow', () => {
  it('is glyph + word + subject, with the reason as result when known', () => {
    expect(tileStatusRow({ status: 'needs_revision', assignee: 'scout' }, 'no sources')).toEqual({
      glyph: '✗',
      word: 'revision',
      subject: 'scout',
      result: 'no sources',
    });
    expect(tileStatusRow({ status: 'blocked', assignee: null })).toEqual({
      glyph: '⚠',
      word: 'blocked',
      subject: 'unassigned',
    });
    expect(tileStatusRow({ status: 'running', assignee: 'x' } as never)).toBe(null);
  });
});
