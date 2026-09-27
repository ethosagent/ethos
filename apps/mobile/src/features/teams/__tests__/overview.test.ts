import type { KanbanTask, LedgerEvent } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { ledgerEmptyLine, ledgerRow, restartCommand, statusStrip } from '../overview';

const team = {
  health: 'running' as const,
  startedAt: '2026-09-01T00:00:00Z',
  dispatchMode: 'coordinator' as const,
  coordinator: 'cmo',
  kanban: { staleMs: 600_000, pollMs: 30_000, stalenessThresholdMs: 0 },
  channels: [{ platform: 'telegram', botKey: 'mkt' }],
};
const now = Date.parse('2026-09-04T04:00:00Z');
const t = (status: KanbanTask['status']) => ({ status }) as KanbanTask;

describe('statusStrip', () => {
  it('renders the four tiles', () => {
    const [sup, dispatch, board, channel] = statusStrip(team, [t('running'), t('blocked')], now);
    expect(sup).toMatchObject({ value: 'Running', detail: 'up 3d 4h', dot: 'live' });
    expect(dispatch).toMatchObject({ value: 'Kanban · Coordinator', detail: 'via cmo · poll 30s' });
    expect(board).toMatchObject({ value: '1 running', detail: '1 blocked · 0 revision · 0 done' });
    expect(channel).toMatchObject({ value: 'Telegram', detail: 'mkt → cmo' });
  });
  it('does not block on a loading board, and says when there is none', () => {
    expect(statusStrip(team, undefined, now)[2]?.detail).toBe('· loading board');
    expect(statusStrip(team, null, now)[2]?.value).toBe('0 · no board yet');
  });
  it('a stopped team is dim with no channel', () => {
    const [sup, , , channel] = statusStrip(
      { ...team, health: 'stopped', startedAt: null, channels: [] },
      [],
      now,
    );
    expect(sup).toMatchObject({ value: 'Stopped', dot: 'dim', detail: null });
    expect(channel?.value).toBe('None bound');
  });
});

describe('ledgerRow', () => {
  const e: LedgerEvent = {
    id: 1,
    at: '2026-09-01T09:41:00',
    kind: 'operator_approved',
    taskId: 'abcdef1234',
    taskTitle: 'Brief',
    personalityId: null,
    headline: 'Operator approved',
    detail: 'verifier bypassed',
    severity: 'ok',
  };
  it('is glyph + kind + subject + result + time', () => {
    expect(ledgerRow(e)).toEqual({
      glyph: '✓',
      word: 'operator approved',
      subject: '#abcdef12',
      result: 'Operator approved · Brief · verifier bypassed',
      time: '09:41',
    });
    expect(ledgerRow({ ...e, severity: 'err', personalityId: 'scout' })).toMatchObject({
      glyph: '✗',
      subject: 'scout',
    });
  });
});

describe('stopped-team lines', () => {
  it('names the CLI', () => {
    expect(ledgerEmptyLine({ name: 'marketing', health: 'stopped' })).toBe(
      'Start it: ethos team start marketing',
    );
    expect(ledgerEmptyLine({ name: 'marketing', health: 'running' })).toBe(null);
    expect(restartCommand('marketing')).toBe(
      'ethos team stop marketing && ethos team start marketing',
    );
  });
});
