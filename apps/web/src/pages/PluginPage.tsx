import { useQuery } from '@tanstack/react-query';
import { Card, Empty, Skeleton, Statistic, Table, Typography } from 'antd';
import { useParams } from 'react-router-dom';
import { rpc } from '../rpc';

// ---------------------------------------------------------------------------
// PluginPage — renders a plugin's declarative page specification.
//
// The page spec is fetched via `rpc.plugins.getPageSpec()`. Each section
// describes a visual block (metric, data-table, chart, tool-output) that
// fetches its data through `rpc.plugins.invokeToolForPage()`. Sections
// with `autoRefreshMs` set up a polling interval via react-query's
// `refetchInterval`.
// ---------------------------------------------------------------------------

export function PluginPage() {
  const { pluginId } = useParams<{ pluginId: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['plugins', 'pageSpec', pluginId],
    queryFn: () => rpc.plugins.getPageSpec({ pluginId: pluginId ?? '' }),
    enabled: Boolean(pluginId),
  });

  if (isLoading) return <Skeleton active />;
  if (error) return <Typography.Text type="danger">{String(error)}</Typography.Text>;
  if (!data?.spec) return <Empty description="This plugin has no page registered." />;

  const { spec } = data;
  const pid = pluginId ?? '';

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <Typography.Title level={3}>{spec.title}</Typography.Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {spec.sections.map((section) => {
          const sectionKey = `${section.type ?? 'section'}-${section.label ?? 'unknown'}`;
          return <PluginSection key={sectionKey} pluginId={pid} section={section} />;
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section renderer — dispatches on `section.type`
// ---------------------------------------------------------------------------

function PluginSection({
  pluginId,
  section,
}: {
  pluginId: string;
  section: Record<string, unknown>;
}) {
  const sectionType = section.type as string;
  const toolName = section.toolName as string | undefined;
  const toolArgs = section.toolArgs as Record<string, unknown> | undefined;
  const label = section.label as string;
  const autoRefreshMs = section.autoRefreshMs as number | undefined;

  const { data, isLoading } = useQuery({
    queryKey: ['plugins', 'toolForPage', pluginId, toolName, toolArgs],
    queryFn: () =>
      rpc.plugins.invokeToolForPage({ pluginId, toolName: toolName ?? '', args: toolArgs }),
    enabled: Boolean(toolName),
    refetchInterval: autoRefreshMs,
  });

  return (
    <Card title={label} size="small">
      {isLoading ? (
        <Skeleton active paragraph={{ rows: 2 }} />
      ) : !toolName ? (
        <Typography.Text type="secondary">No tool configured</Typography.Text>
      ) : !data?.ok ? (
        <Typography.Text type="danger">{data?.error ?? 'Unknown error'}</Typography.Text>
      ) : sectionType === 'metric' ? (
        <MetricSection data={data} section={section} />
      ) : sectionType === 'data-table' ? (
        <DataTableSection data={data} section={section} />
      ) : sectionType === 'chart' ? (
        <ChartSection data={data} section={section} />
      ) : (
        <Typography.Paragraph>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{data.value}</pre>
        </Typography.Paragraph>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Metric — a single <Statistic> driven by `structured[valueField]`
// ---------------------------------------------------------------------------

interface ToolForPageResult {
  ok: boolean;
  value: string;
  structured?: Record<string, unknown>;
  error?: string;
}

function MetricSection({
  data,
  section,
}: {
  data: ToolForPageResult;
  section: Record<string, unknown>;
}) {
  const valueField = (section.valueField as string) ?? 'value';
  const rawValue = data.structured?.[valueField] ?? data.value;
  const numValue = typeof rawValue === 'number' ? rawValue : undefined;
  const strValue = numValue === undefined ? String(rawValue) : undefined;

  return (
    <Statistic
      title={(section.label as string) ?? 'Value'}
      value={numValue}
      formatter={strValue ? () => strValue : undefined}
      suffix={section.suffix as string | undefined}
      prefix={section.prefix as string | undefined}
    />
  );
}

// ---------------------------------------------------------------------------
// DataTable — auto-generates columns from structured data
// ---------------------------------------------------------------------------

function DataTableSection({
  data,
  section,
}: {
  data: ToolForPageResult;
  section: Record<string, unknown>;
}) {
  const dataField = (section.dataField as string) ?? 'rows';
  const raw = data.structured?.[dataField];
  const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];

  if (rows.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No data" />;
  }

  // Derive columns from the first row's keys.
  const firstRow = rows[0];
  const columns = firstRow
    ? Object.keys(firstRow).map((key) => ({
        title: key,
        dataIndex: key,
        key,
        render: (v: unknown) => (v === null || v === undefined ? '' : String(v)),
      }))
    : [];

  return (
    <Table
      dataSource={rows.map((r, i) => ({ ...r, _key: i }))}
      rowKey="_key"
      columns={columns}
      pagination={rows.length > 20 ? { pageSize: 20 } : false}
      size="small"
    />
  );
}

// ---------------------------------------------------------------------------
// Chart — placeholder; actual charting library TBD
// ---------------------------------------------------------------------------

function ChartSection({
  data,
  section,
}: {
  data: ToolForPageResult;
  section: Record<string, unknown>;
}) {
  const chartType = (section.chartType as string) ?? 'line';
  const dataField = (section.dataField as string) ?? 'points';

  return (
    <div
      style={{
        padding: 24,
        border: '1px dashed var(--ant-color-border)',
        borderRadius: 8,
        textAlign: 'center',
        color: 'var(--ant-color-text-secondary)',
      }}
    >
      <Typography.Text type="secondary">
        Chart placeholder ({chartType}) — data field: {dataField}
        {data.structured?.[dataField]
          ? `, ${(data.structured[dataField] as unknown[]).length} points`
          : ''}
      </Typography.Text>
    </div>
  );
}
