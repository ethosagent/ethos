import { useQuery } from '@tanstack/react-query';
import { Segmented, Spin, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { formatTokens, formatUsd } from '../../lib/usage-format';
import { SectionHeading } from '../../pages/settings/components/section-heading';
import { rpc } from '../../rpc';

// Usage — spend and tokens over a window, on the Activity page's Usage tab
// (plan openclaw-2026.9.6-gaps U3). The web face of `ethos usage`: the
// `usage.summary` RPC folds the same rows with the same function the CLI does
// (`summarizeUsageRows`, @ethosagent/session-sqlite), so a window reads the
// same in the terminal and here. Read-only. Numbers are Geist Mono tabular
// (DESIGN.md "Typography"); totals are a row of mono counts, not tiles.

type UsageSummary = Awaited<ReturnType<typeof rpc.usage.summary>>;
type UsageRow = UsageSummary['daily'][number];
type Breakdown = 'model' | 'personality' | 'channel' | 'session';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '24h', value: DAY_MS },
  { label: '7d', value: 7 * DAY_MS },
  { label: '30d', value: 30 * DAY_MS },
];
const BREAKDOWNS: readonly Breakdown[] = ['model', 'personality', 'channel', 'session'];

function columns(keyTitle: string): ColumnsType<UsageRow> {
  const mono = (text: string) => <span className="activity-mono">{text}</span>;
  return [
    { title: keyTitle, dataIndex: 'key', render: (key: string) => mono(key), ellipsis: true },
    {
      title: 'Cost',
      dataIndex: 'estimatedCostUsd',
      align: 'right',
      render: (usd: number) => mono(formatUsd(usd)),
    },
    {
      title: 'In',
      dataIndex: 'inputTokens',
      align: 'right',
      render: (n: number) => mono(formatTokens(n)),
    },
    {
      title: 'Out',
      dataIndex: 'outputTokens',
      align: 'right',
      render: (n: number) => mono(formatTokens(n)),
    },
  ];
}

export function UsagePanel() {
  const [windowMs, setWindowMs] = useState(WINDOWS[1]?.value ?? 7 * DAY_MS);
  const [by, setBy] = useState<Breakdown>('model');
  const query = useQuery({
    queryKey: ['usage', 'summary', windowMs, by],
    queryFn: () => rpc.usage.summary({ windowMs, by }),
  });

  return (
    <div>
      <div className="activity-filter-bar">
        <Segmented<number>
          size="small"
          value={windowMs}
          onChange={setWindowMs}
          options={WINDOWS.map((w) => ({ label: w.label, value: w.value }))}
        />
      </div>
      <UsageBody query={query} by={by} setBy={setBy} />
    </div>
  );
}

function UsageBody({
  query,
  by,
  setBy,
}: {
  query: { isLoading: boolean; data: UsageSummary | undefined; error: unknown };
  by: Breakdown;
  setBy: (b: Breakdown) => void;
}) {
  if (query.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 60 }}>
        <Spin />
      </div>
    );
  }
  const data = query.data;
  if (!data) {
    return (
      <Typography.Text type="secondary">
        Usage unreadable — {query.error instanceof Error ? query.error.message : 'no data'}.
      </Typography.Text>
    );
  }
  const t = data.totals;
  const stats: ReadonlyArray<{ label: string; value: string }> = [
    { label: 'cost', value: formatUsd(t.estimatedCostUsd) },
    { label: 'tokens in', value: formatTokens(t.inputTokens) },
    { label: 'tokens out', value: formatTokens(t.outputTokens) },
    { label: 'cache hits', value: `${(t.cacheHitRate * 100).toFixed(1)}%` },
    { label: 'model calls', value: String(t.messages) },
  ];
  return (
    <>
      <div className="activity-stats">
        {stats.map((s) => (
          <div key={s.label} className="activity-stat">
            <span className="activity-mono">{s.label}</span>
            <span className="activity-count">{s.value}</span>
          </div>
        ))}
      </div>
      {t.messages === 0 ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          Nothing spent in this window. Spend is read from the replies stored in each session, the
          same figure <code>ethos usage</code> prints.
        </Typography.Paragraph>
      ) : (
        <>
          <SectionHeading id="usage-daily">by day (UTC)</SectionHeading>
          <Table<UsageRow>
            size="small"
            rowKey="key"
            pagination={false}
            columns={columns('Day')}
            dataSource={[...data.daily].sort((a, b) => b.key.localeCompare(a.key))}
          />
          <SectionHeading id="usage-breakdown">by {by}</SectionHeading>
          <div className="activity-filter-bar">
            <Segmented<Breakdown>
              size="small"
              value={by}
              onChange={setBy}
              options={BREAKDOWNS.map((b) => ({ label: b, value: b }))}
            />
          </div>
          <Table<UsageRow>
            size="small"
            rowKey="key"
            pagination={false}
            columns={columns(by)}
            dataSource={data.by?.rows ?? []}
          />
        </>
      )}
    </>
  );
}
