import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../../state/AppContext';
import { ProgressBar } from '../../ui/ProgressBar';
import { BatchResultsTable } from './BatchResultsTable';
import { FileDropZone } from './FileDropZone';

interface PersonalityOption {
  id: string;
  name: string;
}

interface RunStatus {
  id: string;
  status: 'running' | 'pending' | 'completed' | 'failed';
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  startedAt: string;
  finishedAt: string | null;
}

interface BatchResult {
  input: string;
  output: string;
  expected?: string;
  score?: number;
  passed: boolean;
}

export function BatchTab() {
  const { state } = useAppState();
  const { port } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [fileContent, setFileContent] = useState<string | null>(null);
  const [personalities, setPersonalities] = useState<PersonalityOption[]>([]);
  const [personalityId, setPersonalityId] = useState('');
  const [concurrency, setConcurrency] = useState(4);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [runResults, setRunResults] = useState<BatchResult[] | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await client.rpc.personalities.list({});
        if (cancelled) return;
        const items = res.items.map((p: { id: string; name: string }) => ({
          id: p.id,
          name: p.name,
        }));
        setPersonalities(items);
        if (items.length > 0 && !personalityId) {
          setPersonalityId(res.defaultId ?? items[0].id);
        }
      } catch {
        // best-effort
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [client, personalityId]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollRun = useCallback(
    (id: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const res = await client.rpc.batch.get({ id });
          const run = res.run;
          setRunStatus({
            id: run.id,
            status: run.status,
            total: run.total,
            completed: run.completed,
            failed: run.failed,
            skipped: run.skipped,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          });
          if (run.status !== 'running' && run.status !== 'pending') {
            stopPolling();
            try {
              const output = await client.rpc.batch.output({ id });
              const lines = output.content
                .split('\n')
                .filter(Boolean)
                .map((line) => {
                  try {
                    return JSON.parse(line) as BatchResult;
                  } catch {
                    return null;
                  }
                })
                .filter((r): r is BatchResult => r !== null);
              setRunResults(lines);
            } catch {
              setRunResults([]);
            }
          }
        } catch {
          stopPolling();
        }
      }, 2000);
    },
    [client, stopPolling],
  );

  useEffect(() => {
    return stopPolling;
  }, [stopPolling]);

  const handleStart = useCallback(async () => {
    if (!fileContent) return;
    try {
      const res = await client.rpc.batch.start({
        tasksJsonl: fileContent,
        concurrency,
        defaultPersonalityId: personalityId,
      });
      const run = res.run;
      setActiveRunId(run.id);
      setRunResults(null);
      setRunStatus({
        id: run.id,
        status: run.status,
        total: run.total,
        completed: run.completed,
        failed: run.failed,
        skipped: run.skipped,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      });
      pollRun(run.id);
    } catch {
      // best-effort
    }
  }, [client, fileContent, concurrency, personalityId, pollRun]);

  const handleDownload = useCallback(async () => {
    if (!activeRunId) return;
    try {
      const res = await client.rpc.batch.output({ id: activeRunId });
      await window.ethos.file.save({
        defaultName: `batch-${activeRunId.slice(0, 8)}.jsonl`,
        content: res.content,
      });
    } catch {
      // best-effort
    }
  }, [client, activeRunId]);

  const progress = runStatus && runStatus.total > 0 ? runStatus.completed / runStatus.total : 0;
  const isRunning = runStatus?.status === 'running' || runStatus?.status === 'pending';
  const isDone = runStatus && !isRunning;

  function formatEta(): string {
    if (!runStatus || !isRunning || runStatus.completed === 0) return '...';
    const elapsed = Date.now() - new Date(runStatus.startedAt).getTime();
    const rate = runStatus.completed / elapsed;
    const remaining = runStatus.total - runStatus.completed;
    const etaMs = remaining / rate;
    const secs = Math.round(etaMs / 1000);
    if (secs < 60) return `${secs}s`;
    return `${Math.round(secs / 60)}m ${secs % 60}s`;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <FileDropZone onFile={setFileContent} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, height: 32 }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Personality</span>
        <select
          value={personalityId}
          onChange={(e) => setPersonalityId(e.target.value)}
          style={{
            width: 200,
            fontSize: 13,
            color: 'var(--text-primary)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            padding: '4px 8px',
            outline: 'none',
          }}
        >
          {personalities.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Concurrency</span>
        <input
          type="number"
          min={1}
          max={16}
          value={concurrency}
          onChange={(e) => setConcurrency(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
          style={{
            width: 60,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            textAlign: 'center',
            color: 'var(--text-primary)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            padding: '4px 8px',
            outline: 'none',
          }}
        />
      </div>

      <button
        type="button"
        onClick={handleStart}
        disabled={!fileContent || isRunning}
        style={{
          height: 36,
          width: '100%',
          marginTop: 12,
          borderRadius: 'var(--radius-sm)',
          border: 'none',
          background: !fileContent || isRunning ? 'var(--bg-overlay)' : 'var(--accent)',
          color: !fileContent || isRunning ? 'var(--text-tertiary)' : '#fff',
          fontSize: 13,
          fontWeight: 600,
          cursor: !fileContent || isRunning ? 'default' : 'pointer',
          transition: 'background var(--motion-fast) var(--ease)',
        }}
      >
        Start batch
      </button>

      {activeRunId && isRunning && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
            Run {activeRunId.slice(0, 8)}
          </span>
          <ProgressBar value={progress} />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-tertiary)',
            }}
          >
            {runStatus?.completed ?? 0} / {runStatus?.total ?? 0} complete &middot; ETA{' '}
            {formatEta()}
          </span>
        </div>
      )}

      {isDone && runResults && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <BatchResultsTable results={runResults} />
          <button
            type="button"
            onClick={handleDownload}
            style={{
              height: 32,
              padding: '0 16px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
              background: 'transparent',
              color: 'var(--text-primary)',
              fontSize: 13,
              cursor: 'pointer',
              alignSelf: 'flex-start',
            }}
          >
            Download results
          </button>
        </div>
      )}
    </div>
  );
}
