interface Metrics {
  toolCalls: number;
  tokensUsed: number;
  estCost: number;
  errorRate: number;
  toolCallsDelta?: number;
  tokensDelta?: number;
  costDelta?: number;
  errorDelta?: number;
}

interface MetricsRowProps {
  metrics: Metrics;
}

function formatDelta(value: number | undefined): React.ReactNode {
  if (value == null) return null;
  const sign = value >= 0 ? '+' : '';
  const color = value >= 0 ? 'var(--success)' : 'var(--error)';
  return (
    <span style={{ fontSize: 12, color }}>
      {sign}
      {value}% vs yesterday
    </span>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--text-tertiary)',
  marginTop: 4,
};

const valueStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 24,
  fontWeight: 600,
  color: 'var(--text-primary)',
  fontVariantNumeric: 'tabular-nums',
};

export function MetricsRow({ metrics }: MetricsRowProps) {
  const chips: Array<{ value: string; label: string; delta?: number }> = [
    {
      value: metrics.toolCalls.toLocaleString(),
      label: 'TOOL CALLS TODAY',
      delta: metrics.toolCallsDelta,
    },
    {
      value: metrics.tokensUsed.toLocaleString(),
      label: 'TOKENS USED',
      delta: metrics.tokensDelta,
    },
    {
      value: `$${metrics.estCost.toFixed(2)}`,
      label: 'EST. COST',
      delta: metrics.costDelta,
    },
    {
      value: `${metrics.errorRate.toFixed(1)}%`,
      label: 'ERROR RATE',
      delta: metrics.errorDelta,
    },
  ];

  return (
    <div style={{ display: 'flex', gap: 24 }}>
      {chips.map((chip) => (
        <div key={chip.label}>
          <div style={valueStyle}>{chip.value}</div>
          <div style={labelStyle}>{chip.label}</div>
          {formatDelta(chip.delta)}
        </div>
      ))}
    </div>
  );
}
