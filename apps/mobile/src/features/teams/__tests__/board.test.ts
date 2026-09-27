import type { KanbanEvent } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  columnChips,
  columnTasks,
  defaultColumn,
  recentEventRows,
  STATUS_COLUMNS,
  taskReasons,
  tileMeta,
} from '../board';

const ev = (id: number, taskId: string, kind: KanbanEvent['kind'], data = {}): KanbanEvent => ({
  id,
  taskId,
  kind,
  actor: 'scout',
  data,
  createdAt: `2026-09-01T00:00:0${id}Z`,
});

describe('columnChips', () => {
  it('follows the web order with counts', () => {
    const chips = columnChips([{ status: 'todo' }, { status: 'todo' }, { status: 'done' }]);
    expect(chips.map((c) => c.status)).toEqual([...STATUS_COLUMNS]);
    expect(chips[0]?.label).toBe('todo · 2');
    expect(chips.find((c) => c.status === 'needs_revision')?.label).toBe('revision · 0');
  });
  it('shows blank counts while loading', () => {
    expect(columnChips(null)[0]).toEqual({ status: 'todo', count: null, label: 'todo · –' });
  });
});

describe('defaultColumn', () => {
  it('opens on what needs the operator, then the first non-empty', () => {
    expect(defaultColumn([{ status: 'done' }, { status: 'blocked' }])).toBe('blocked');
    expect(defaultColumn([{ status: 'done' }, { status: 'ready' }])).toBe('ready');
    expect(defaultColumn([])).toBe('todo');
  });
});

describe('columnTasks', () => {
  it('filters to a status, priority then recency', () => {
    const t = (id: string, priority: number, updatedAt: string) => ({
      id,
      status: 'todo' as const,
      priority,
      updatedAt,
    });
    const out = columnTasks([t('a', 1, '1'), t('b', 2, '1'), t('c', 1, '2')], 'todo');
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('taskReasons', () => {
  it('takes the verifier verdict and the block summary, last write wins', () => {
    const r = taskReasons([
      ev(1, 't1', 'status_changed', { to: 'needs_revision', reason: 'old' }),
      ev(2, 't1', 'status_changed', { to: 'needs_revision', reason: 'no sources' }),
      ev(3, 't2', 'run_completed', { outcome: 'blocked', summary: 'rate limit' }),
      ev(4, 't3', 'run_completed', { outcome: 'completed', summary: 'ok' }),
    ]);
    expect([...r]).toEqual([
      ['t1', 'no sources'],
      ['t2', 'rate limit'],
    ]);
  });
});

describe('tileMeta', () => {
  it('shows retries once retried', () => {
    expect(tileMeta({ assignee: 'scout', retryCount: 0, maxRetries: 3 })).toBe('scout');
    expect(tileMeta({ assignee: 'scout', retryCount: 1, maxRetries: 3 })).toBe('scout · retry 1/3');
    expect(tileMeta({ assignee: null, retryCount: 2, maxRetries: null })).toBe(
      'unassigned · retry 2/∞',
    );
  });
});

describe('recentEventRows', () => {
  it('newest first, heartbeats dropped, titled', () => {
    const rows = recentEventRows(
      [
        ev(1, 't1', 'run_started'),
        ev(2, 't1', 'heartbeat'),
        ev(3, 't1', 'status_changed', { to: 'done' }),
      ],
      [{ id: 't1', title: 'Write the brief' }],
    );
    expect(rows.map((r) => [r.glyph, r.word, r.subject])).toEqual([
      ['✓', 'done', 'Write the brief'],
      ['·', 'claimed', 'Write the brief'],
    ]);
  });
});
