import { Typography } from 'antd';
import { useInitiativeMetrics } from '../../features/initiatives/api/queries';

// Read-only Gate 1 / Gate 2 approve rates (plan initiative-engine, "Metrics and
// success criteria"), from `rpc.initiatives.metrics`. Renders nothing while
// loading or on error: the metrics are context, not a reason to block the tab.

const pct = (rate: number) => `${Math.round(rate * 100)}%`;

export function InitiativeMetrics({ id }: { id: string }) {
  const { data } = useInitiativeMetrics(id);
  if (!data) return null;
  const { gate1, gate2 } = data;
  return (
    <div data-initiative-metrics style={{ marginBottom: 16 }}>
      <Typography.Text strong>Decision rates</Typography.Text>
      {gate1.asked === 0 ? (
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          Nothing asked yet. Rates appear once this personality asks to explore something.
        </Typography.Paragraph>
      ) : (
        <>
          <Typography.Paragraph style={{ margin: 0 }}>
            Gate 1: {gate1.approved} of {gate1.asked} approved ({pct(gate1.rate)})
          </Typography.Paragraph>
          <Typography.Paragraph style={{ margin: 0 }}>
            Gate 2: {gate2.adopted} of {gate2.briefs} adopted ({pct(gate2.rate)})
          </Typography.Paragraph>
        </>
      )}
    </div>
  );
}
