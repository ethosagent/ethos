import type { KanbanEvent } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  APPROVE_REASON,
  auditRows,
  criteriaRows,
  decisionSettled,
  retriesLabel,
  taskActions,
  verifierVerdict,
  wasBypassed,
} from '../task';

const ev = (
  id: number,
  kind: KanbanEvent['kind'],
  data: Record<string, unknown> = {},
  taskId = 't1',
): KanbanEvent => ({
  id,
  taskId,
  kind,
  actor: id === 2 ? 'eval-harness' : 'scout',
  data,
  createdAt: `2026-09-01T00:00:0${id}Z`,
});

describe('taskActions', () => {
  it('offers both verbs only where there is something to decide', () => {
    expect(taskActions('needs_revision')).toEqual(['send-back', 'approve']);
    expect(taskActions('blocked')).toEqual(['send-back', 'approve']);
    expect(taskActions('running')).toEqual(['send-back', 'approve']);
    for (const s of ['todo', 'ready', 'done', 'failed', 'archived', 'scheduled'] as const) {
      expect(taskActions(s)).toEqual([]);
    }
  });
  it('keeps the ledger marker the server reads', () => {
    expect(APPROVE_REASON).toContain('verifier bypassed');
  });
});

describe('decisionSettled', () => {
  const pending = {
    target: 'done' as const,
    fromStatus: 'needs_revision' as const,
    fromUpdatedAt: 'a',
  };
  it('holds until the status changes', () => {
    expect(decisionSettled(pending, { status: 'needs_revision', updatedAt: 'a' })).toBe(false);
    expect(decisionSettled(pending, { status: 'done', updatedAt: 'b' })).toBe(true);
  });
  it('a send-back on needs_revision settles when updatedAt moves', () => {
    const p = {
      target: 'needs_revision' as const,
      fromStatus: 'needs_revision' as const,
      fromUpdatedAt: 'a',
    };
    expect(decisionSettled(p, { status: 'needs_revision', updatedAt: 'a' })).toBe(false);
    expect(decisionSettled(p, { status: 'needs_revision', updatedAt: 'b' })).toBe(true);
  });
});

describe('criteriaRows', () => {
  const text = '- cites three sources\n2. under 500 words\n\n';
  it('splits lines and strips list markers', () => {
    expect(criteriaRows(text, 'running', false).map((r) => r.text)).toEqual([
      'cites three sources',
      'under 500 words',
    ]);
  });
  it('✓ met only on a verified done; never invents per-criterion failures', () => {
    expect(criteriaRows(text, 'done', false).every((r) => r.word === 'met')).toBe(true);
    expect(criteriaRows(text, 'done', true).every((r) => r.word === 'open')).toBe(true);
    expect(criteriaRows(text, 'needs_revision', false).every((r) => r.word === 'open')).toBe(true);
    expect(criteriaRows('one thing', 'needs_revision', false)[0]?.word).toBe('unmet');
  });
  it('no criteria → no rows', () => {
    expect(criteriaRows(null, 'done', false)).toEqual([]);
  });
});

describe('verifierVerdict and wasBypassed', () => {
  const events = [
    ev(1, 'run_started'),
    ev(2, 'status_changed', { from: 'running', to: 'needs_revision', reason: 'only one source' }),
    ev(3, 'status_changed', { to: 'done', reason: APPROVE_REASON }, 't2'),
  ];
  it('quotes the newest rejection while the task is still in revision', () => {
    expect(verifierVerdict(events, 't1', 'needs_revision')).toMatchObject({
      reason: 'only one source',
      actor: 'eval-harness',
    });
    expect(verifierVerdict(events, 't1', 'done')).toBe(null);
  });
  it('detects an operator bypass', () => {
    expect(wasBypassed(events, 't2')).toBe(true);
    expect(wasBypassed(events, 't1')).toBe(false);
  });
});

describe('auditRows', () => {
  it('interleaves events and comment text oldest first', () => {
    const rows = auditRows(
      [ev(1, 'created'), ev(4, 'heartbeat'), ev(5, 'commented', { commentId: 'c' })],
      [
        {
          id: 'c',
          taskId: 't1',
          author: 'human:key:iphone',
          body: 'add a source',
          createdAt: '2026-09-01T00:00:03Z',
        },
      ],
      't1',
    );
    expect(rows.map((r) => [r.word, r.subject])).toEqual([
      ['created', 'scout'],
      ['comment', 'human:key:iphone'],
    ]);
  });
});

describe('retriesLabel', () => {
  it('formats the budget', () => {
    expect(retriesLabel({ retryCount: 1, maxRetries: 3 })).toBe('1 / 3');
    expect(retriesLabel({ retryCount: 0, maxRetries: null })).toBe('0 / ∞');
  });
});
