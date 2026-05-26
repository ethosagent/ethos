import { useCallback, useMemo, useRef, useState } from 'react';
import { SparklineChart } from '../../ui/SparklineChart';

interface CostDataPoint {
  date: string;
  cost: number;
}

interface CostSparklineProps {
  data: CostDataPoint[];
}

function extractDayLabel(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

export function CostSparkline({ data }: CostSparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);

  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      containerRef.current = node;
      setWidth(node.getBoundingClientRect().width);
    }
  }, []);

  const values = useMemo(() => data.map((d) => d.cost), [data]);
  const labels = useMemo(() => data.map((d) => extractDayLabel(d.date)), [data]);

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
        DAILY COST (LAST 7 DAYS)
      </div>
      <div ref={measureRef}>
        <SparklineChart data={values} width={width} height={60} labels={labels} />
      </div>
    </div>
  );
}
