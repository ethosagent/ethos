import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Divider,
  Dropdown,
  Empty,
  Input,
  message,
  Popover,
  Select,
  Skeleton,
  Space,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactGridLayout, WidthProvider } from 'react-grid-layout/legacy';

const SizedGrid = WidthProvider(ReactGridLayout);

import { toPng } from 'html-to-image';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { useParams } from 'react-router-dom';
import { DashboardPanelShell } from '../components/dashboard/DashboardPanelShell';
import { ParamFilterBar } from '../components/dashboard/ParamFilterBar';
import { ParamSchemaEditor } from '../components/dashboard/ParamSchemaEditor';
import { readTrustedParamMessage } from '../lib/dashboard-param-message';
import { rpc } from '../rpc';

function DashboardCronPopover({
  cronSchedule,
  onSave,
}: {
  cronSchedule: string | null;
  onSave: (val: string | null) => void;
}) {
  const [val, setVal] = useState(cronSchedule ?? '');
  const PRESETS = [
    { label: 'Every 5 min', value: '*/5 * * * *' },
    { label: 'Every 15 min', value: '*/15 * * * *' },
    { label: 'Every 30 min', value: '*/30 * * * *' },
    { label: 'Every hour', value: '0 * * * *' },
    { label: 'Every 4 hours', value: '0 */4 * * *' },
    { label: 'Daily at 9am', value: '0 9 * * *' },
    { label: 'Weekdays at 9am', value: '0 9 * * 1-5' },
    { label: 'Clear', value: '' },
  ];
  function describe(expr: string): string {
    const p = expr.trim().split(/\s+/);
    if (p.length !== 5) return expr;
    const [min, hour, , , dow] = p;
    if (min === '*' && hour === '*') return 'every min';
    const mMatch = min.match(/^\*\/(\d+)$/);
    if (mMatch && hour === '*') return `every ${mMatch[1]}m`;
    const hMatch = hour.match(/^\*\/(\d+)$/);
    if (hMatch && min === '0') return `every ${hMatch[1]}h`;
    if (min === '0' && /^\d+$/.test(hour)) {
      const suffix = dow === '1-5' ? ' weekdays' : '';
      return `daily ${hour}:00${suffix}`;
    }
    return expr;
  }
  return (
    <div style={{ width: 300 }}>
      <div style={{ marginBottom: 8, fontSize: 12, color: '#666' }}>
        Auto-refreshes all panels in this dashboard on schedule.
      </div>
      <Select
        style={{ width: '100%', marginBottom: 8 }}
        placeholder="Choose preset…"
        options={PRESETS.map((p) => ({ label: p.label, value: p.value }))}
        onChange={(v: string) => setVal(v)}
        value={undefined}
      />
      <Input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="*/15 * * * *"
        style={{ marginBottom: 4 }}
      />
      {val && (
        <div style={{ fontSize: 11, color: '#52c41a', marginBottom: 8 }}>↻ {describe(val)}</div>
      )}
      {!val && cronSchedule && (
        <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>Will clear the schedule.</div>
      )}
      <Button type="primary" size="small" onClick={() => onSave(val || null)} block>
        Save
      </Button>
    </div>
  );
}

interface PanelPos {
  id: string;
  col: number;
  row: number;
  w: number;
  h: number;
}

function computeAutoLayout(panels: PanelPos[]): PanelPos[] {
  // Sort by current position (row asc, col asc) to preserve rough order
  const sorted = [...panels].sort((a, b) => a.row - b.row || a.col - b.col);
  const result: PanelPos[] = [];
  let y = 0;
  let rowX = 0;
  let rowH = 0;

  for (const p of sorted) {
    // Wide panels (w>6) take a full row; others get half (w=6)
    const w = p.w > 6 ? 12 : 6;
    const h = p.h;

    if (rowX + w > 12) {
      // Doesn't fit — flush current row, start new
      y += rowH;
      rowX = 0;
      rowH = 0;
    }

    result.push({ id: p.id, col: rowX, row: y, w, h });
    rowX += w;
    rowH = Math.max(rowH, h);

    if (rowX >= 12) {
      // Row full — advance
      y += rowH;
      rowX = 0;
      rowH = 0;
    }
  }

  return result;
}

export function DashboardView() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const gridRef = useRef<HTMLDivElement>(null);

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

  const updatePanelMut = useMutation({
    mutationFn: (vars: {
      panelId: string;
      title?: string;
      cronSchedule?: string | null;
      dependsOn?: string[] | null;
      emitConfig?: Array<{ on: 'rowClick'; param: string; column: string; default: string }> | null;
    }) => rpc.dashboards.updatePanel(vars),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard', id] }),
  });

  const [persistentParams, setPersistentParams] = useState<Record<string, string>>({});
  const [ephemeralParams, setEphemeralParams] = useState<Record<string, string>>({});
  const [editingParams, setEditingParams] = useState(false);

  const dashboardParamsCurrent = data?.dashboard?.paramsCurrent;
  useEffect(() => {
    if (dashboardParamsCurrent) {
      setPersistentParams(dashboardParamsCurrent);
    }
  }, [dashboardParamsCurrent]);

  useEffect(() => {
    if (!data?.panels) return;
    const sorted = [...data.panels].sort((a, b) => a.row - b.row || a.col - b.col);
    const initial: Record<string, string> = {};
    for (const panel of sorted) {
      for (const rule of panel.emitConfig ?? []) {
        if (!(rule.param in initial)) {
          initial[rule.param] = rule.default;
        }
      }
    }
    setEphemeralParams(initial);
  }, [data?.panels]);

  const emitParam = useCallback(
    (key: string, value: string) => {
      setEphemeralParams((prev) => ({ ...prev, [key]: value }));
      queryClient.invalidateQueries({ queryKey: ['dashboard', id] });
    },
    [id, queryClient],
  );

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      const msg = readTrustedParamMessage(e, window);
      if (msg) emitParam(msg.param, msg.value);
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [emitParam]);

  const updateDashboardMut = useMutation({
    mutationFn: (vars: {
      cronSchedule?: string | null;
      paramsSchema?: Array<{
        key: string;
        label: string;
        type: 'select' | 'options' | 'date-range';
        options?: string[];
        default: string;
      }>;
    }) => rpc.dashboards.update({ id: id as string, ...vars }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard', id] }),
  });

  const updateParamsMut = useMutation({
    mutationFn: (paramsCurrent: Record<string, string>) =>
      rpc.dashboards.updateParams({ id: id as string, paramsCurrent }),
    onSuccess: () => {
      refreshAllMut.mutate();
    },
  });

  const autoArrangeMut = useMutation({
    mutationFn: async () => {
      const newLayout = computeAutoLayout(
        panels.map((p) => ({ id: p.id, col: p.col, row: p.row, w: p.w, h: p.h })),
      );
      await Promise.all(
        newLayout.map((item) =>
          rpc.dashboards.updatePanelLayout({
            panelId: item.id,
            col: item.col,
            row: item.row,
            w: item.w,
            h: item.h,
          }),
        ),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard', id] });
      messageApi.success('Dashboard arranged');
    },
  });

  function handlePersistentChange(key: string, value: string) {
    const next = { ...persistentParams, [key]: value };
    setPersistentParams(next);
    updateParamsMut.mutate(next);
    queryClient.invalidateQueries({ queryKey: ['dashboard', id] });
  }

  function handleEphemeralClear(key: string) {
    setEphemeralParams((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  if (isLoading) return <Skeleton active />;
  if (!data) return <Empty description="Dashboard not found" />;

  const { dashboard, panels } = data;
  const livePanels = panels.filter((p) => p.queryType !== 'static' && p.queryType !== 'header');

  async function handleExport() {
    try {
      const result = await rpc.dashboards.exportDashboard({ id: id ?? '' });
      const blob = new Blob([result.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `${dashboard.title}.json`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
      messageApi.success('Dashboard exported');
    } catch {
      messageApi.error('Export failed');
    }
  }

  async function handleScreenshot() {
    const el = gridRef.current;
    if (!el) return;
    try {
      const dataUrl = await toPng(el, { cacheBust: true });
      const link = document.createElement('a');
      link.download = `${dashboard.title}.png`;
      link.href = dataUrl;
      link.click();
      messageApi.success('Screenshot saved');
    } catch {
      messageApi.error('Screenshot failed — HTML template panels may appear blank');
    }
  }

  const serverLayout = panels.map((p) => ({
    i: p.id,
    x: p.col,
    y: p.row,
    w: p.w,
    h: p.h,
    minW: 2,
    minH: 2,
  }));

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
            <Button size="small" type="text" onClick={() => setEditingParams(true)}>
              Params
            </Button>
            <Popover
              trigger="click"
              title="Dashboard schedule"
              placement="bottomRight"
              content={
                <DashboardCronPopover
                  cronSchedule={dashboard.cronSchedule}
                  onSave={(val) => updateDashboardMut.mutate({ cronSchedule: val })}
                />
              }
            >
              <Button size="small" type={dashboard.cronSchedule ? 'default' : 'text'}>
                {dashboard.cronSchedule ? `⏱ ${dashboard.cronSchedule}` : '⏱ Schedule'}
              </Button>
            </Popover>
            {livePanels.length > 0 && (
              <Button onClick={() => refreshAllMut.mutate()} loading={refreshAllMut.isPending}>
                Refresh All ({livePanels.length})
              </Button>
            )}
            <Button onClick={() => autoArrangeMut.mutate()} loading={autoArrangeMut.isPending}>
              Auto Arrange
            </Button>
            <Dropdown
              menu={{
                items: [
                  { key: 'export', label: 'Export JSON' },
                  { key: 'screenshot', label: 'Screenshot (PNG)' },
                  { key: 'print', label: 'Print' },
                ],
                onClick: ({ key }) => {
                  if (key === 'export') handleExport();
                  if (key === 'screenshot') handleScreenshot();
                  if (key === 'print') window.print();
                },
              }}
            >
              <Button size="small" type="text">
                ...
              </Button>
            </Dropdown>
          </Space>
        </div>
      </div>
      <Divider style={{ margin: '0 0 16px 0' }} />

      <ParamFilterBar
        schema={dashboard.paramsSchema ?? []}
        persistent={persistentParams}
        ephemeral={ephemeralParams}
        onPersistentChange={handlePersistentChange}
        onEphemeralClear={handleEphemeralClear}
      />

      {panels.length === 0 ? (
        <Empty description="No panels yet — save blocks from chat to get started" />
      ) : (
        <div ref={gridRef}>
          <SizedGrid
            layout={serverLayout}
            cols={12}
            rowHeight={60}
            compactType="vertical"
            isDraggable={false}
            isResizable={false}
          >
            {panels.map((panel) => (
              <div key={panel.id} style={{ height: '100%' }}>
                <DashboardPanelShell
                  panel={panel}
                  allPanels={panels.map((p) => ({ id: p.id, title: p.title }))}
                  onDelete={() => deletePanelMut.mutate(panel.id)}
                  onRefresh={() => refreshPanelMut.mutate(panel.id)}
                  refreshing={refreshPanelMut.isPending && refreshPanelMut.variables === panel.id}
                  onUpdatePanel={(vars) => updatePanelMut.mutate({ panelId: panel.id, ...vars })}
                  onEmit={emitParam}
                />
              </div>
            ))}
          </SizedGrid>
        </div>
      )}

      <ParamSchemaEditor
        open={editingParams}
        schema={dashboard.paramsSchema ?? []}
        onCancel={() => setEditingParams(false)}
        onSave={(schema) => {
          updateDashboardMut.mutate({ paramsSchema: schema });
          setEditingParams(false);
        }}
      />

      <style>{`
        @media print {
          .ant-layout-sider,
          .ant-layout-header,
          .ant-btn,
          .ant-tag { display: none !important; }
        }
      `}</style>
    </div>
  );
}
