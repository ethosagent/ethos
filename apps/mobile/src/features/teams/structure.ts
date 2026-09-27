import { memberPresence } from '@ethosagent/chat-state';
import type { KanbanTask, TeamMemberSummary } from '@ethosagent/web-contracts';

// Structure (§6): the web canvas as a tree — the coordinator on top with a
// `lead` marker, one edge, the members beneath. Liveness uses the same
// `memberPresence` the Overview's state lines use, so the two never disagree.

export type Liveness = 'running' | 'blocked' | 'idle' | 'offline';

export interface StructureNode {
  personalityId: string;
  lead: boolean;
  /** `capability · model` in mono; the model comes from `personalities.list`. */
  line: string;
  liveness: Liveness;
}

export interface StructureTree {
  lead: StructureNode | null;
  members: StructureNode[];
}

export function liveness(
  member: TeamMemberSummary,
  tasks: KanbanTask[],
  coordinator: string | null,
): Liveness {
  const p = memberPresence(member, tasks, coordinator);
  if (p.state === 'dim') return 'offline';
  if (p.state === 'err') return 'blocked';
  return p.live ? 'running' : 'idle';
}

export function buildStructure(
  team: { coordinator: string | null; members: TeamMemberSummary[] },
  tasks: KanbanTask[],
  modelOf: (personalityId: string) => string | null,
): StructureTree {
  const node = (m: TeamMemberSummary): StructureNode => ({
    personalityId: m.personalityId,
    lead: m.personalityId === team.coordinator,
    line: [m.capabilities.join(', ') || m.role, modelOf(m.personalityId)]
      .filter(Boolean)
      .join(' · '),
    liveness: liveness(m, tasks, team.coordinator),
  });
  const leadMember = team.members.find((m) => m.personalityId === team.coordinator);
  return {
    lead: leadMember ? node(leadMember) : null,
    members: team.members.filter((m) => m !== leadMember).map(node),
  };
}

export const LEGEND: readonly Liveness[] = ['running', 'blocked', 'idle'];
