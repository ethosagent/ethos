import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Empty, message, Skeleton, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { rpc } from '../rpc';

export function Dashboards() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => rpc.dashboards.list(),
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const deleteMut = useMutation({
    mutationFn: (id: string) => rpc.dashboards.delete({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboards'] }),
  });

  const importMut = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      return rpc.dashboards.importDashboard({ exportJson: text });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      if (result.warnings.length > 0) {
        message.warning(result.warnings.join('\n'));
      }
      navigate(`/dashboards/${result.dashboardId}`);
    },
    onError: () => {
      message.error('Import failed');
    },
  });

  const { data: templatesData } = useQuery({
    queryKey: ['widgetTemplates'],
    queryFn: () => rpc.dashboards.listWidgetTemplates(),
  });

  const templates = templatesData?.templates ?? [];

  const addFromTemplateMut = useMutation({
    mutationFn: (t: (typeof templates)[number]) =>
      rpc.dashboards.addPanel({
        dashboardId: null,
        newDashboardTitle: t.title,
        personalityId: 'default',
        panel: {
          queryType: t.queryType,
          blockType: t.queryType === 'sql' ? 'table' : 'html',
          content: '',
          title: t.title,
          sqlQuery: t.sql,
          prompt: t.prompt,
          pluginId: t.pluginId,
          dataSourceId: t.dataSource,
        },
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      navigate(`/dashboards/${result.panel.dashboardId}`);
    },
  });

  if (isLoading) return <Skeleton active />;

  const dashboards = data?.dashboards ?? [];

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 24,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          Dashboards
        </Typography.Title>
        <Space>
          <input
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            id="import-dashboard"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importMut.mutate(file);
              e.target.value = '';
            }}
          />
          <Button onClick={() => document.getElementById('import-dashboard')?.click()}>
            Import
          </Button>
          <Button type="primary" onClick={() => navigate('/dashboards/create')}>
            Create Dashboard
          </Button>
        </Space>
      </div>

      {dashboards.length === 0 ? (
        <Empty description="No dashboards yet" />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {dashboards.map((d) => (
            <Card
              key={d.id}
              hoverable
              onClick={() => navigate(`/dashboards/${d.id}`)}
              actions={[
                <Button
                  key="del"
                  type="text"
                  danger
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteMut.mutate(d.id);
                  }}
                >
                  Delete
                </Button>,
              ]}
            >
              <Card.Meta
                title={d.title}
                description={`${d.personalityId || 'No personality'} · ${new Date(d.createdAt).toLocaleDateString()}`}
              />
            </Card>
          ))}
        </div>
      )}
      {templates.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <Typography.Title level={5} style={{ marginBottom: 12 }}>
            Available Plugin Widgets
          </Typography.Title>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {templates.map((t) => (
              <Card
                key={`${t.pluginId}-${t.id}`}
                size="small"
                hoverable
                onClick={() => addFromTemplateMut.mutate(t)}
              >
                <Card.Meta title={t.title} description={`${t.queryType} · ${t.pluginId}`} />
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
