import { useEffect, useState } from 'react';
import { CostSparkline } from './CostSparkline';
import { ErrorLogTable } from './ErrorLogTable';
import { MetricsRow } from './MetricsRow';
import { ToolCallChart } from './ToolCallChart';

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

interface ToolCallData {
  name: string;
  count: number;
}

interface CostDataPoint {
  date: string;
  cost: number;
}

interface ErrorEntry {
  timestamp: string;
  personality: string;
  tool: string;
  error: string;
}

export function ObservabilityPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallData[]>([]);
  const [costHistory, setCostHistory] = useState<CostDataPoint[]>([]);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);

  useEffect(() => {
    // observability RPC not yet in contract — show empty state
    setMetrics({ toolCalls: 0, tokensUsed: 0, estCost: 0, errorRate: 0 });
    setToolCalls([]);
    setCostHistory([]);
    setErrors([]);
  }, []);

  return (
    <div
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        overflowY: 'auto',
        height: '100%',
      }}
    >
      {metrics && <MetricsRow metrics={metrics} />}
      <ToolCallChart data={toolCalls} />
      <CostSparkline data={costHistory} />
      <ErrorLogTable errors={errors} />
    </div>
  );
}
