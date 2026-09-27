import type { KanbanTask, TeamMemberSummary } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { buildStructure } from '../structure';

const m = (
  personalityId: string,
  role: 'coordinator' | 'member',
  status: TeamMemberSummary['status'] = 'running',
  capabilities: string[] = [],
): TeamMemberSummary => ({ personalityId, role, tier: null, status, capabilities });

const task = (assignee: string, status: KanbanTask['status']) =>
  ({
    id: `${assignee}-t`,
    title: 't',
    assignee,
    status,
    updatedAt: new Date().toISOString(),
  }) as KanbanTask;

describe('buildStructure', () => {
  it('puts the coordinator on top and members beneath with liveness', () => {
    const tree = buildStructure(
      {
        coordinator: 'cmo',
        members: [
          m('scout', 'member', 'running', ['research']),
          m('cmo', 'coordinator'),
          m('writer', 'member'),
          m('editor', 'member', 'stopped'),
          m('seo', 'member'),
        ],
      },
      [task('scout', 'running'), task('writer', 'blocked')],
      (id) => (id === 'scout' ? 'claude-haiku' : null),
    );
    expect(tree.lead).toMatchObject({ personalityId: 'cmo', lead: true, liveness: 'running' });
    expect(tree.members.map((n) => [n.personalityId, n.liveness, n.line])).toEqual([
      ['scout', 'running', 'research · claude-haiku'],
      ['writer', 'blocked', 'member'],
      ['editor', 'offline', 'member'],
      ['seo', 'idle', 'member'],
    ]);
  });
  it('has no lead when the team has no coordinator', () => {
    expect(
      buildStructure({ coordinator: null, members: [m('a', 'member')] }, [], () => null).lead,
    ).toBe(null);
  });
});
