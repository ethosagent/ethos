import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { kanbanKeys } from '../../features/kanban/api/keys';
import { outboxKeys } from '../../features/outbox/api/keys';
import { needsYou } from '../../lib/teamPresence';
import { buildTeamPath } from '../../lib/workspaceRoutes';
import { rpc } from '../../rpc';

// The breadcrumb's "Needs you" pill (plan/phases/teams-as-a-scope.md D11,
// T4): counts the team's `needs_revision` + `blocked` tickets and opens the
// Board on the first one. Shares the board query key with the panes, so a
// pane's SSE-driven invalidation refreshes the count too; the 5s interval
// covers the panes that don't read the board (Memory, Settings, …). A plain
// `useQuery` rather than `useKanbanBoard` so the chrome never opens a second
// SSE stream beside the pane's. Hidden at zero.
//
// trust-before-reach O-T10 adds the second thing a team can owe a person: an
// outbox item in `awaiting_approval`, which nothing in the deployment moves
// until a human reads the text and approves it. It shares the Outbox pane's
// query key for the same reason the board half shares the board's — a decision
// made in the pane drops the count here without a second poll. A ticket still
// wins the deep link when there is one; with only publications waiting, the
// pill opens the Outbox.

export function NeedsYouPill({ teamId }: { teamId: string }) {
  const enabled = teamId.length > 0;
  const boardQuery = useQuery({
    queryKey: kanbanKeys.board(teamId),
    queryFn: () => rpc.kanban.getBoard({ team: teamId }),
    refetchInterval: 5_000,
    enabled,
  });
  const outboxQuery = useQuery({
    queryKey: outboxKeys.list({ teamId }),
    queryFn: () => rpc.outbox.list({ teamId }),
    refetchInterval: 5_000,
    enabled,
  });
  const pending = needsYou(boardQuery.data?.board.tasks ?? []);
  const awaiting = (outboxQuery.data?.items ?? []).filter(
    (item) => item.state === 'awaiting_approval',
  );
  const n = pending.length + awaiting.length;
  if (n === 0) return null;
  const first = pending[0];
  const to = first
    ? `${buildTeamPath(teamId, 'board')}?task=${encodeURIComponent(first.id)}`
    : buildTeamPath(teamId, 'outbox');
  return (
    <Link
      to={to}
      className="team-needs-pill"
      title={
        first
          ? 'Tickets waiting on you — open the first'
          : 'Publications waiting on your approval — open the Outbox'
      }
    >
      {n} {n === 1 ? 'needs' : 'need'} you
    </Link>
  );
}
