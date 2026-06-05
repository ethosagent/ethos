import type { KanbanBoardSnapshot, KanbanTeamSummary } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatusDot } from '../components/ui/StatusDot';
import { rpc } from '../rpc';

// Teams listing — entry point to Plan B's Control Center.
//
// 2-column card grid showing team name (mono), online status, description,
// team meta, two stat numbers (in-progress + done-this-week), and an
// "Open board" button that links into the per-team Control Center.
// Refetches every 5s so a `ethos team start` surfaces without a hard reload.

export function Teams() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ['kanban', 'list'],
    queryFn: () => rpc.kanban.list(),
    refetchInterval: 5_000,
  });

  const teams = data?.teams ?? [];

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <span style={{ color: 'var(--red)', fontSize: 13 }}>
          Failed to load teams: {(error as Error).message}
        </span>
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      {/* Page header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 600,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-display)',
            }}
          >
            Teams
          </h1>
          <span
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-display)',
            }}
          >
            {teams.length} {teams.length === 1 ? 'team' : 'teams'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => navigate('/teams/create')}
          style={{
            fontSize: 12,
            fontFamily: 'var(--font-display)',
            fontWeight: 500,
            padding: '8px 14px',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            background: 'var(--blue)',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Create team
        </button>
      </header>

      {/* Card grid */}
      {teams.length === 0 ? (
        <div
          style={{
            marginTop: 48,
            textAlign: 'center',
            color: 'var(--text-tertiary)',
            fontSize: 13,
          }}
        >
          No teams configured. Create one with{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            ethos team create &lt;name&gt;
          </code>{' '}
          and start it with{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            ethos team start &lt;name&gt;
          </code>
          .
        </div>
      ) : (
        <div className="teams-grid">
          {teams.map((team) => (
            <TeamCard key={team.name} team={team} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TeamCard — individual team card in the grid
// ---------------------------------------------------------------------------

function TeamCard({ team }: { team: KanbanTeamSummary }) {
  const navigate = useNavigate();

  // Fetch board snapshot to derive stats
  const { data: boardData } = useQuery({
    queryKey: ['kanban', 'board', team.name],
    queryFn: () => rpc.kanban.getBoard({ team: team.name }),
    refetchInterval: 10_000,
  });

  const stats = useMemo(() => {
    if (!boardData) return { inProgress: 0, doneThisWeek: 0 };
    return deriveStats(boardData.board);
  }, [boardData]);

  const onlineText = deriveOnlineText(team);
  const onlineDotColor = team.health === 'running' ? 'var(--green)' : 'var(--text-tertiary)';

  return (
    <div className="team-card">
      {/* Header: name + online status */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--text-primary)',
          }}
        >
          {team.name}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: 'var(--text-secondary)',
          }}
        >
          <StatusDot color={onlineDotColor} size={8} />
          {onlineText}
        </span>
      </div>

      {/* Description */}
      {team.description && (
        <div
          style={{
            marginTop: 8,
            fontSize: 13,
            color: 'var(--text-secondary)',
            lineHeight: 1.4,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {team.description}
        </div>
      )}

      {/* Team meta */}
      <div
        style={{
          marginTop: 4,
          fontSize: 12,
          color: 'var(--text-tertiary)',
        }}
      >
        {team.dispatchMode} team &middot; {team.memberCount}{' '}
        {team.memberCount === 1 ? 'agent' : 'agents'}
      </div>

      {/* Stats row */}
      <div style={{ marginTop: 16, display: 'flex', gap: 24 }}>
        <div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 700,
              fontFamily: 'var(--font-display)',
              color: 'var(--text-primary)',
              lineHeight: 1.2,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {stats.inProgress}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
            }}
          >
            in progress
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 700,
              fontFamily: 'var(--font-display)',
              color: 'var(--text-primary)',
              lineHeight: 1.2,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {stats.doneThisWeek}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
            }}
          >
            done this week
          </div>
        </div>
      </div>

      {/* Open board button */}
      <button
        type="button"
        className="team-card-open-btn"
        onClick={() => navigate(`/teams/${encodeURIComponent(team.name)}`)}
      >
        Open board &rarr;
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveStats(board: KanbanBoardSnapshot): {
  inProgress: number;
  doneThisWeek: number;
} {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  let inProgress = 0;
  let doneThisWeek = 0;

  for (const task of board.tasks) {
    if (task.status === 'running') {
      inProgress += 1;
    }
    if (task.status === 'done') {
      const updated = new Date(task.updatedAt).getTime();
      if (Number.isFinite(updated) && updated >= weekAgo) {
        doneThisWeek += 1;
      }
    }
  }

  return { inProgress, doneThisWeek };
}

function deriveOnlineText(team: KanbanTeamSummary): string {
  if (team.health !== 'running') return 'offline';
  if (team.runningCount === 0) return 'offline';
  if (team.runningCount === 1) return 'online';
  return `${team.runningCount} agents online`;
}
