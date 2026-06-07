import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Checkbox, Input, message, Select, Steps, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { rpc } from '../rpc';

interface SelectedTemplate {
  pluginId: string;
  templateId: string;
  title: string;
  queryType: 'sql' | 'prompt';
  sql?: string;
  prompt?: string;
  dataSource?: string;
  cronSchedule?: string;
}

export function CreateDashboardFlow() {
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [personalityId, setPersonalityId] = useState('');
  const [selected, setSelected] = useState<SelectedTemplate[]>([]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();

  const { data: persData } = useQuery({
    queryKey: ['personalities'],
    queryFn: () => rpc.personalities.list({}),
  });

  const { data: templatesData } = useQuery({
    queryKey: ['widgetTemplates'],
    queryFn: () => rpc.dashboards.listWidgetTemplates(),
    enabled: step >= 1,
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const { dashboard } = await rpc.dashboards.create({ title, personalityId });
      for (const tmpl of selected) {
        await rpc.dashboards.addPanel({
          dashboardId: dashboard.id,
          panel: {
            queryType: tmpl.queryType,
            blockType: tmpl.queryType === 'sql' ? 'table' : 'html',
            content: '',
            title: tmpl.title,
            sqlQuery: tmpl.sql,
            prompt: tmpl.prompt,
            pluginId: tmpl.pluginId,
            dataSourceId: tmpl.dataSource,
            cronSchedule: tmpl.cronSchedule,
          },
        });
      }
      return dashboard;
    },
    onSuccess: (dashboard) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      messageApi.success('Dashboard created');
      navigate(`/dashboards/${dashboard.id}`);
    },
  });

  const templates = templatesData?.templates ?? [];

  const toggleTemplate = (t: (typeof templates)[number]) => {
    const existing = selected.find((s) => s.templateId === t.id && s.pluginId === t.pluginId);
    if (existing) {
      setSelected(selected.filter((s) => !(s.templateId === t.id && s.pluginId === t.pluginId)));
    } else {
      setSelected([
        ...selected,
        {
          pluginId: t.pluginId,
          templateId: t.id,
          title: t.title,
          queryType: t.queryType,
          sql: t.sql ?? undefined,
          prompt: t.prompt ?? undefined,
          dataSource: t.dataSource ?? undefined,
          cronSchedule: t.defaultCron ?? undefined,
        },
      ]);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
      {contextHolder}
      <Typography.Title level={3}>Create Dashboard</Typography.Title>
      <Steps
        current={step}
        style={{ marginBottom: 24 }}
        items={[{ title: 'Details' }, { title: 'Widget Catalog' }, { title: 'Confirm' }]}
      />

      {step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input
            placeholder="Dashboard title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Select
            placeholder="Select personality"
            value={personalityId || undefined}
            onChange={setPersonalityId}
            options={(persData?.items ?? []).map((p: { id: string; name: string }) => ({
              label: p.name,
              value: p.id,
            }))}
          />
          <Button type="primary" disabled={!title || !personalityId} onClick={() => setStep(1)}>
            Next
          </Button>
        </div>
      )}

      {step === 1 && (
        <div>
          {templates.length === 0 ? (
            <div style={{ color: '#888', padding: 20, textAlign: 'center' }}>
              No widget templates available. You can add panels manually after creation.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {templates.map((t) => {
                const isSelected = selected.some(
                  (s) => s.templateId === t.id && s.pluginId === t.pluginId,
                );
                return (
                  <Card
                    key={`${t.pluginId}-${t.id}`}
                    size="small"
                    style={{
                      cursor: 'pointer',
                      border: isSelected ? '1px solid #1890ff' : undefined,
                    }}
                    onClick={() => toggleTemplate(t)}
                  >
                    <Checkbox checked={isSelected} style={{ marginRight: 8 }} />
                    <strong>{t.title}</strong>
                    {t.description && (
                      <div style={{ color: '#888', fontSize: 12 }}>{t.description}</div>
                    )}
                    <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                      {t.queryType} · {t.pluginId}
                      {t.defaultCron ? ` · ${t.defaultCron}` : ''}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <Button onClick={() => setStep(0)}>Back</Button>
            <Button type="primary" onClick={() => setStep(2)}>
              {selected.length > 0 ? `Next (${selected.length} selected)` : 'Skip — Start Empty'}
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <Typography.Text strong>Dashboard: {title}</Typography.Text>
          {selected.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Typography.Text>Widgets to add:</Typography.Text>
              <ul>
                {selected.map((s) => (
                  <li key={s.templateId}>
                    {s.title} ({s.queryType})
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <Button onClick={() => setStep(1)}>Back</Button>
            <Button type="primary" loading={createMut.isPending} onClick={() => createMut.mutate()}>
              Create Dashboard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
