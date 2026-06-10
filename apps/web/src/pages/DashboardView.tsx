import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Divider, Empty, message, Skeleton, Space, Typography } from 'antd';
import { type Layout, Responsive, WidthProvider } from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { useParams } from 'react-router-dom';
import { DashboardPanelShell } from '../components/dashboard/DashboardPanelShell';
import { rpc } from '../rpc';

const ResponsiveGrid = WidthProvider(Responsive);

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

  const layout = panels.map((p) => ({
    i: p.id,
    x: p.col,
    y: p.row,
    w: p.w,
    h: p.h,
    minW: 2,
    minH: 2,
  }));

  const handleLayoutChange = (newLayout: Layout) => {
    for (const item of newLayout) {
      const panel = panels.find((p) => p.id === item.i);
      if (
        panel &&
        (panel.col !== item.x || panel.row !== item.y || panel.w !== item.w || panel.h !== item.h)
      ) {
        rpc.dashboards.updatePanelLayout({
          panelId: item.i,
          col: item.x,
          row: item.y,
          w: item.w,
          h: item.h,
        });
      }
    }
    queryClient.invalidateQueries({ queryKey: ['dashboard', id] });
  };

  return (
    <div style={{ padding: 24 }}>
      {contextHolder}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <div />
        <Typography.Title level={3} style={{ margin: 0 }}>
          {dashboard.title}
        </Typography.Title>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Space>
            {livePanels.length > 0 && (
              <Button onClick={() => refreshAllMut.mutate()} loading={refreshAllMut.isPending}>
                Refresh All ({livePanels.length})
              </Button>
            )}
          </Space>
        </div>
      </div>
      <Divider style={{ margin: '0 0 16px 0' }} />

      {panels.length === 0 ? (
        <Empty description="No panels yet — save blocks from chat to get started" />
      ) : (
        <ResponsiveGrid
          layouts={{ lg: layout }}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
          cols={{ lg: 12, md: 10, sm: 6, xs: 4 }}
          rowHeight={60}
          onLayoutChange={(newLayout: Layout) => handleLayoutChange(newLayout)}
          draggableHandle=".drag-handle"
          compactType="vertical"
        >
          {panels.map((panel) => (
            <div key={panel.id} style={{ height: '100%' }}>
              <DashboardPanelShell
                panel={panel}
                onDelete={() => deletePanelMut.mutate(panel.id)}
                onRefresh={() => refreshPanelMut.mutate(panel.id)}
                refreshing={refreshPanelMut.isPending && refreshPanelMut.variables === panel.id}
              />
            </div>
          ))}
        </ResponsiveGrid>
      )}
    </div>
  );
}
