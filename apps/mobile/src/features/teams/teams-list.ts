import type { KanbanTaskSummary, TeamSummary } from '@ethosagent/web-contracts';
import type { RowData } from '../../lib/row';

// The Teams root (§6): the large title's subtitle, one row per team, and the
// "Attention across teams" tiles — all from ONE `teams.list` call (S11). A
// server older than S11 sends no `attentionCount` / `attention`: the row then
// drops its `N need attention` suffix and there are no tiles — nothing is
// invented (§11a PARTIAL). The schema types both fields as present, so the
// guard reads them as optional on purpose.

type TeamRowInput = Pick<TeamSummary, 'name' | 'memberCount' | 'coordinator' | 'health'> & {
  attentionCount?: number;
  attention?: KanbanTaskSummary[];
};

/** `N running · M stopped` — `stale` counts as stopped (its supervisor is gone). */
export function teamsSubtitle(teams: readonly Pick<TeamSummary, 'health'>[]): string {
  const running = teams.filter((t) => t.health === 'running').length;
  return `${running} running · ${teams.length - running} stopped`;
}

/** `4 members · cmo · 2 need attention`; the suffix only when the server sent a count > 0. */
export function teamRowSubtitle(team: TeamRowInput): string {
  const parts = [`${team.memberCount} ${team.memberCount === 1 ? 'member' : 'members'}`];
  if (team.coordinator) parts.push(team.coordinator);
  if (typeof team.attentionCount === 'number' && team.attentionCount > 0) {
    parts.push(`${team.attentionCount} need${team.attentionCount === 1 ? 's' : ''} attention`);
  }
  return parts.join(' · ');
}

export interface AttentionTile {
  team: string;
  task: KanbanTaskSummary;
}

/** Every team's `attention` tiles, newest first. `null` when no team carried the
 *  field — an older server — so the screen renders no tiles section at all. */
export function attentionTiles(teams: readonly TeamRowInput[]): AttentionTile[] | null {
  if (!teams.some((t) => Array.isArray(t.attention))) return null;
  return teams
    .flatMap((t) => (t.attention ?? []).map((task) => ({ team: t.name, task })))
    .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
}

/** The reason row inside a tile (glyph + word, no stripe — §12 amendment 16).
 *  The summary carries no reason text, so the row names the state and the assignee. */
export function tileStatusRow(
  task: Pick<KanbanTaskSummary, 'status' | 'assignee'>,
  reason?: string,
): RowData | null {
  const subject = task.assignee ?? 'unassigned';
  if (task.status === 'needs_revision') {
    return { glyph: '✗', word: 'revision', subject, ...(reason ? { result: reason } : {}) };
  }
  if (task.status === 'blocked') {
    return { glyph: '⚠', word: 'blocked', subject, ...(reason ? { result: reason } : {}) };
  }
  if (task.status === 'failed') {
    return { glyph: '✗', word: 'failed', subject, ...(reason ? { result: reason } : {}) };
  }
  return null;
}

/** `#1a2b3c4d · p2` — the tile's mono id line. */
export function tileIdLine(task: Pick<KanbanTaskSummary, 'id' | 'priority'>): string {
  return `#${task.id.slice(0, 8)} · p${task.priority}`;
}
