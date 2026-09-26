import { describe, expect, it } from 'vitest';
import { groupAgents, teamLine } from '../grouping';

const p = (id: string, description: string | null = null) => ({ id, name: id, description });
const personalities = [
  p('engineer', 'writes code'),
  p('cmo'),
  p('scout'),
  p('personality-architect'),
  p('team-architect'),
];
const teams = [
  {
    name: 'marketing',
    members: [
      { personalityId: 'cmo', role: 'coordinator' as const },
      { personalityId: 'scout', role: 'member' as const },
    ],
  },
];

describe('groupAgents', () => {
  it('splits independent, in-teams and built-in helpers', () => {
    const s = groupAgents(personalities, teams);
    expect(s.independent.map((r) => r.personality.id)).toEqual(['engineer']);
    expect(s.inTeams.map((r) => [r.personality.id, r.teamLine])).toEqual([
      ['cmo', 'marketing · coordinator'],
      ['scout', 'marketing · member'],
    ]);
    expect(s.helpers.map((r) => r.personality.id)).toEqual([
      'personality-architect',
      'team-architect',
    ]);
  });

  it('puts every non-helper under Independent when teams failed to load', () => {
    const s = groupAgents(personalities, null);
    expect(s.independent.map((r) => r.personality.id)).toEqual(['engineer', 'cmo', 'scout']);
    expect(s.inTeams).toEqual([]);
  });

  it('a helper listed in a team stays a helper', () => {
    const s = groupAgents(personalities, [
      { name: 'x', members: [{ personalityId: 'team-architect', role: 'member' }] },
    ]);
    expect(s.helpers.map((r) => r.personality.id)).toContain('team-architect');
  });

  it('search narrows by id, name or description', () => {
    const s = groupAgents(personalities, teams, 'CODE');
    expect(s.independent.map((r) => r.personality.id)).toEqual(['engineer']);
    expect(s.inTeams).toEqual([]);
    expect(s.helpers).toEqual([]);
  });

  it('names every team a member sits in', () => {
    expect(
      teamLine('cmo', [
        ...teams,
        { name: 'sales', members: [{ personalityId: 'cmo', role: 'member' }] },
      ]),
    ).toBe('marketing · coordinator, sales · member');
    expect(teamLine('nobody', teams)).toBeNull();
  });
});
