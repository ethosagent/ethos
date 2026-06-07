import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Empty, message, Skeleton, Space, Typography } from 'antd';
import { useParams } from 'react-router-dom';
import { DashboardPanelShell } from '../components/dashboard/DashboardPanelShell';
import { rpc } from '../rpc';

export function DashboardView() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', id],
    queryFn: () => rpc.dashboards.get({ id: id as string }),
    enabled: !!id,
  });

  const refreshAllMut = useMutation({
    mutationFn: () => rpc.dashboards.refreshAll({ dashboardId: id as string }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard', id] });
      messageApi.success('All panels refreshed');
    },
  });

  const deletePanelMut = useMutation({
    mutationFn: (panelId: string) => rpc.dashboards.deletePanel({ panelId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard', id] }),
  });

  const refreshPanelMut = useMutation({
    mutationFn: (panelId: string) => rpc.dashboards.refreshPanel({ panelId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard', id] }),
  });

  if (isLoading) return <Skeleton active />;
  if (!data) return <Empty description="Dashboard not found" />;

  const { dashboard, panels } = data;
  const livePanels = panels.filter((p) => p.queryType !== 'static');

  return (
    <div style={{ padding: 24 }}>
      {contextHolder}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 24,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          {dashboard.title}
        </Typography.Title>
        <Space>
          {livePanels.length > 0 && (
            <Button onClick={() => refreshAllMut.mutate()} loading={refreshAllMut.isPending}>
              Refresh All ({livePanels.length})
            </Button>
          )}
        </Space>
      </div>

      {panels.length === 0 ? (
        <Empty description="No panels yet — save blocks from chat to get started" />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(12, 1fr)',
            gap: 16,
            alignItems: 'start',
          }}
        >
          {panels.map((panel) => (
            <div
              key={panel.id}
              style={{
                gridColumn: `span ${panel.w}`,
                minHeight: panel.h * 60,
              }}
            >
              <DashboardPanelShell
                panel={panel}
                onDelete={() => deletePanelMut.mutate(panel.id)}
                onRefresh={
                  panel.queryType !== 'static' ? () => refreshPanelMut.mutate(panel.id) : undefined
                }
                refreshing={refreshPanelMut.isPending}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
