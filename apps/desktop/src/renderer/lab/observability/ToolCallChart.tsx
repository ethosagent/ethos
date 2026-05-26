import { useMemo, useState } from 'react';
import { ProgressBar } from '../../ui/ProgressBar';

interface ToolCallData {
  name: string;
  count: number;
}

interface ToolCallChartProps {
  data: ToolCallData[];
}

const VISIBLE_LIMIT = 10;

export function ToolCallChart({ data }: ToolCallChartProps) {
  const [expanded, setExpanded] = useState(false);

  const sorted = useMemo(() => [...data].sort((a, b) => b.count - a.count), [data]);

  const maxCount = sorted.length > 0 ? sorted[0].count : 1;
  const visible = expanded ? sorted : sorted.slice(0, VISIBLE_LIMIT);
  const hasMore = sorted.length > VISIBLE_LIMIT;

  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-tertiary)',
          marginBottom: 8,
        }}
      >
        TOOL CALLS BY NAME (LAST 7 DAYS)
      </div>
      {visible.map((item) => (
        <div
          key={item.name}
          style={{
            height: 28,
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-secondary)',
              width: 140,
              flexShrink: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.name}
          </span>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
            <ProgressBar value={item.count / maxCount} height={4} color="var(--info)" />
          </div>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-tertiary)',
              width: 60,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
              flexShrink: 0,
            }}
          >
            {item.count.toLocaleString()}
          </span>
        </div>
      ))}
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--info)',
            fontSize: 12,
            cursor: 'pointer',
            padding: '8px 0',
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
