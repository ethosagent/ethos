import { boardCounts, humanDuration } from '@ethosagent/chat-state';
import type { KanbanTask, LedgerEvent, TeamDetail } from '@ethosagent/web-contracts';
import { clock, type Glyph, type RowData } from '../../lib/row';

// Overview (§6): the 2×2 status strip, and the supervisor ledger as feedback
// rows. Read off `teams.get`, `kanban.getBoard` and `teams.ledger` only.

export type DotTone = 'live' | 'warn' | 'dim' | 'none';

export interface StripTile {
  key: 'supervisor' | 'dispatch' | 'board' | 'channel';
  label: string;
  value: string;
  /** Mono detail beneath the value, e.g. `up 3d 4h`. */
  detail: string | null;
  dot: DotTone;
}

type TeamForStrip = Pick<
  TeamDetail,
  'health' | 'startedAt' | 'dispatchMode' | 'coordinator' | 'kanban' | 'channels'
>;

/**
 * The four tiles. `tasks` undefined = the board is still loading: the Board
 * tile says so and the strip is not blocked (§11a PARTIAL); `null` = the team
 * has no board yet (`0 · no board yet`).
 */
export function statusStrip(
  team: TeamForStrip,
  tasks: readonly KanbanTask[] | null | undefined,
  now: number,
): StripTile[] {
  const started = team.startedAt ? Date.parse(team.startedAt) : Number.NaN;
  const supervisor: StripTile =
    team.health === 'running'
      ? {
          key: 'supervisor',
          label: 'Supervisor',
          value: 'Running',
          detail: Number.isFinite(started) ? `up ${humanDuration(now - started)}` : null,
          dot: 'live',
        }
      : team.health === 'stale'
        ? { key: 'supervisor', label: 'Supervisor', value: 'Stale', detail: null, dot: 'warn' }
        : { key: 'supervisor', label: 'Supervisor', value: 'Stopped', detail: null, dot: 'dim' };

  const mode = team.dispatchMode.charAt(0).toUpperCase() + team.dispatchMode.slice(1);
  const dispatch: StripTile = {
    key: 'dispatch',
    label: 'Dispatch',
    value: `Kanban · ${mode}`,
    detail: `${team.coordinator ? `via ${team.coordinator} · ` : ''}poll ${humanDuration(team.kanban.pollMs)}`,
    dot: 'none',
  };

  let board: StripTile;
  if (tasks === undefined) {
    board = { key: 'board', label: 'Board', value: '–', detail: '· loading board', dot: 'none' };
  } else if (tasks === null) {
    board = { key: 'board', label: 'Board', value: '0 · no board yet', detail: null, dot: 'none' };
  } else {
    const c = boardCounts([...tasks]);
    board = {
      key: 'board',
      label: 'Board',
      value: `${c.running} running`,
      detail: `${c.blocked} blocked · ${c.needsRevision} revision · ${c.done} done`,
      dot: 'none',
    };
  }

  const ch = team.channels[0];
  const channel: StripTile = ch
    ? {
        key: 'channel',
        label: 'Channel',
        value: ch.platform.charAt(0).toUpperCase() + ch.platform.slice(1),
        detail: `${ch.botKey}${team.coordinator ? ` → ${team.coordinator}` : ''}`,
        dot: 'none',
      }
    : { key: 'channel', label: 'Channel', value: 'None bound', detail: null, dot: 'none' };

  return [supervisor, dispatch, board, channel];
}

const SEVERITY_GLYPH: Record<LedgerEvent['severity'], Glyph> = {
  ok: '✓',
  warn: '⚠',
  err: '✗',
  info: '·',
  dim: '·',
};

/** One supervisor-ledger line as a feedback row: glyph + kind, the member (or
 *  ticket) as subject, the headline and detail as result, the time. */
export function ledgerRow(e: LedgerEvent): RowData {
  const subject =
    e.personalityId ?? (e.taskId ? `#${e.taskId.slice(0, 8)}` : e.kind.replace('_', ' '));
  const result = [e.headline, e.taskTitle, e.detail].filter(Boolean).join(' · ');
  return {
    glyph: SEVERITY_GLYPH[e.severity],
    word: e.kind.replace(/_/g, ' '),
    subject,
    result,
    time: clock(Date.parse(e.at)),
  };
}

/** The ledger's empty line: a stopped team is told how to start it (§11). */
export function ledgerEmptyLine(team: Pick<TeamDetail, 'name' | 'health'>): string | null {
  return team.health === 'running' ? null : `Start it: ethos team start ${team.name}`;
}

/** The Settings Restart statement — a CLI line, not a control (teams-as-a-scope D13). */
export function restartCommand(team: string): string {
  return `ethos team stop ${team} && ethos team start ${team}`;
}
