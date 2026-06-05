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

const fieldLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-tertiary)',
  marginBottom: 6,
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 13,
  color: 'var(--text-primary)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: '7px 10px',
  outline: 'none',
};

const numberInputStyle: React.CSSProperties = {
  width: 80,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  color: 'var(--text-primary)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: '7px 10px',
  outline: 'none',
};

export function BatchTab() {
  const { state } = useAppState();
  const { port } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [personalities, setPersonalities] = useState<PersonalityOption[]>([]);
  const [personalityId, setPersonalityId] = useState('');
  const [concurrency, setConcurrency] = useState(4);
  const [maxRetries, setMaxRetries] = useState(2);
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

  const handleFile = useCallback((content: string, name: string, size: number) => {
    setFileContent(content);
    setFileName(name);
    setFileSize(size);
  }, []);

  const handleClearFile = useCallback(() => {
    setFileContent(null);
    setFileName(null);
    setFileSize(null);
  }, []);

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
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Left config panel */}
      <div
        style={{
          width: 280,
          flexShrink: 0,
          borderRight: '1px solid var(--border-subtle)',
          padding: '20px 16px',
          background: 'var(--bg-base)',
          overflowY: 'auto',
        }}
      >
        <FileDropZone
          label="Dataset"
          fileName={fileName}
          fileSize={fileSize}
          onFile={handleFile}
          onClear={handleClearFile}
        />

        <div style={{ marginTop: 16 }}>
          <div style={fieldLabelStyle}>Personality</div>
          <select
            value={personalityId}
            onChange={(e) => setPersonalityId(e.target.value)}
            style={selectStyle}
          >
            {personalities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={fieldLabelStyle}>Concurrency</div>
          <input
            type="number"
            min={1}
            max={20}
            value={concurrency}
            onChange={(e) => setConcurrency(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            style={numberInputStyle}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={fieldLabelStyle}>Max retries</div>
          <input
            type="number"
            min={0}
            max={5}
            value={maxRetries}
            onChange={(e) => setMaxRetries(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
            style={numberInputStyle}
          />
        </div>

        <button
          type="button"
          onClick={handleStart}
          disabled={!fileContent || isRunning}
          style={{
            width: '100%',
            marginTop: 24,
            padding: 10,
            borderRadius: 'var(--radius-sm)',
            border: 'none',
            background: !fileContent || isRunning ? 'var(--bg-overlay)' : 'var(--blue)',
            color: !fileContent || isRunning ? 'var(--text-tertiary)' : '#fff',
            fontSize: 13,
            fontWeight: 500,
            cursor: !fileContent || isRunning ? 'default' : 'pointer',
            transition: 'background var(--motion-fast) var(--ease)',
          }}
        >
          Run batch
        </button>
      </div>

      {/* Right results panel */}
      <div
        style={{
          flex: 1,
          padding: '20px 24px',
          background: 'var(--bg-base)',
          overflowY: 'auto',
        }}
      >
        {activeRunId && isRunning ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Running&hellip; {runStatus?.completed ?? 0}/{runStatus?.total ?? 0} completed
            </span>
            <ProgressBar value={progress} color="var(--blue)" />
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-tertiary)',
              }}
            >
              ETA {formatEta()}
            </span>
          </div>
        ) : isDone && runResults ? (
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
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: 4,
            }}
          >
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Results will appear here
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              Run a batch to see results.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
