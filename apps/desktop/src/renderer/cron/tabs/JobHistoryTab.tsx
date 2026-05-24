import { createEthosClient } from '@ethosagent/sdk';
import { useEffect, useMemo, useState } from 'react';

interface CronRun {
  ranAt: string;
  outputPath: string;
  output: string | null;
}

interface JobHistoryTabProps {
  jobId: string;
  port: number;
  onViewOutput: (run: { ranAt: string; output: string | null; outputPath: string }) => void;
}

export function JobHistoryTab({ jobId, port, onViewOutput }: JobHistoryTabProps) {
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client.rpc.cron
      .history({ id: jobId, limit: 10 })
      .then((res) => {
        if (!cancelled) setRuns(res.runs);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, jobId]);

  if (loading) {
    return (
      <div style={{ padding: '20px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
        Loading history...
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div style={{ padding: '20px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
        No runs yet.
      </div>
    );
  }

  return (
    <div>
      {runs.map((run) => {
        const date = new Date(run.ranAt);
        const dateStr = date.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
        const hasOutput = run.output !== null;

        return (
          <div
            key={run.ranAt}
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 36,
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-secondary)',
                flex: 1,
              }}
            >
              {dateStr}
            </span>
            <span style={{ fontSize: 12, marginRight: 12 }}>
              {hasOutput ? (
                <span style={{ color: 'var(--success)' }}>✓</span>
              ) : (
                <span style={{ color: 'var(--error)' }}>✗</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => onViewOutput(run)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
                color: 'var(--info)',
                padding: 0,
              }}
            >
              View →
            </button>
          </div>
        );
      })}
    </div>
  );
}
