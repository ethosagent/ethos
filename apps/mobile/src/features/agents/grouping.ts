// The Agents root's three sections (§5): Independent, In teams, Built-in
// helpers. Independent = listed in no `teams.list[].members` (teams-as-a-scope
// D3). Built-in helpers are the system personalities — the web's
// SYSTEM_PERSONALITY_IDS (apps/web/src/features/personalities/constants.ts),
// copied because apps/web is not a package the phone can import.

export const BUILT_IN_HELPER_IDS: ReadonlySet<string> = new Set([
  'debug',
  'personality-architect',
  'team-architect',
]);

export const ARCHITECT_ID = 'personality-architect';

export interface AgentLike {
  id: string;
  name: string;
  description: string | null;
}

export interface TeamLike {
  name: string;
  members: ReadonlyArray<{ personalityId: string; role: 'coordinator' | 'member' }>;
}

export interface AgentRowView<P extends AgentLike = AgentLike> {
  personality: P;
  /** `marketing · coordinator` — one entry per team the agent sits in. */
  teamLine: string | null;
}

export interface AgentSections<P extends AgentLike = AgentLike> {
  independent: AgentRowView<P>[];
  inTeams: AgentRowView<P>[];
  helpers: AgentRowView<P>[];
}

/** `team · role` for every team the personality is in, joined with `, `. */
export function teamLine(personalityId: string, teams: readonly TeamLike[]): string | null {
  const parts = teams.flatMap((t) =>
    t.members.filter((m) => m.personalityId === personalityId).map((m) => `${t.name} · ${m.role}`),
  );
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * `teams` null means `teams.list` failed or is not granted: every agent is
 * then Independent (§11a PARTIAL), and the screen says why above the section.
 * `query` narrows by name, id or description, case-insensitive.
 */
export function groupAgents<P extends AgentLike>(
  personalities: readonly P[],
  teams: readonly TeamLike[] | null,
  query = '',
): AgentSections<P> {
  const q = query.trim().toLowerCase();
  const matches = (p: P) =>
    !q || `${p.id} ${p.name} ${p.description ?? ''}`.toLowerCase().includes(q);
  const sections: AgentSections<P> = { independent: [], inTeams: [], helpers: [] };
  for (const p of personalities) {
    if (!matches(p)) continue;
    const line = teams ? teamLine(p.id, teams) : null;
    const row = { personality: p, teamLine: line };
    if (BUILT_IN_HELPER_IDS.has(p.id)) sections.helpers.push(row);
    else if (line) sections.inTeams.push(row);
    else sections.independent.push(row);
  }
  return sections;
}
