import type { KanbanTeamSummary } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Empty, Spin, Table, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { rpc } from '../rpc';

// Teams listing — entry point to Plan B's Control Center.
//
// Lists every team manifest in ~/.ethos/teams/*.yaml, merges in the runtime
// health (`running` / `stale` / `stopped`), and links into the per-team
// Control Center on click. Refetches every 5s so a `ethos team start`
// surfaces without a hard reload.

export function Teams() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['kanban', 'list'],
    queryFn: () => rpc.kanban.list(),
    refetchInterval: 5_000,
  });

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load teams: {(error as Error).message}
      </Typography.Text>
    );
  }

  const teams = data?.teams ?? [];

  return (
    <div className="teams-tab">
      <header className="teams-toolbar" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <span>
          {teams.length} {teams.length === 1 ? 'team' : 'teams'}
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={() => void refetch()} loading={isFetching}>
          Refresh
        </Button>
      </header>

      <Table<KanbanTeamSummary>
        rowKey="name"
        dataSource={teams}
        pagination={false}
        size="small"
        onRow={(record) => ({
          onClick: () => navigate(`/teams/${encodeURIComponent(record.name)}`),
          style: { cursor: 'pointer' },
        })}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No teams configured. Create one with `ethos team create <name>` and start it with `ethos team start <name>`."
            />
          ),
        }}
        columns={[
          {
            title: 'Team',
            dataIndex: 'name',
            key: 'name',
            render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
          },
          {
            title: 'Description',
            dataIndex: 'description',
            key: 'description',
            ellipsis: true,
            render: (text: string) =>
              text ? (
                <Typography.Text>{text}</Typography.Text>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          {
            title: 'Mode',
            dataIndex: 'dispatchMode',
            key: 'dispatchMode',
            width: 120,
            render: (mode: KanbanTeamSummary['dispatchMode']) => <Tag bordered={false}>{mode}</Tag>,
          },
          {
            title: 'Members',
            key: 'members',
            width: 140,
            render: (_: unknown, record: KanbanTeamSummary) => (
              <span>
                {record.runningCount}/{record.memberCount} running
              </span>
            ),
          },
          {
            title: 'Health',
            dataIndex: 'health',
            key: 'health',
            width: 110,
            render: (health: KanbanTeamSummary['health']) => <HealthBadge health={health} />,
          },
        ]}
      />
    </div>
  );
}

function HealthBadge({ health }: { health: KanbanTeamSummary['health'] }): JSX.Element {
  if (health === 'running') return <Badge status="success" text="running" />;
  if (health === 'stale') return <Badge status="warning" text="stale" />;
  return <Badge status="default" text="stopped" />;
}
