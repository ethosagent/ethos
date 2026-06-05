import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../../state/AppContext';
import { ProgressBar } from '../../ui/ProgressBar';
import { BatchResultsTable } from './BatchResultsTable';
import { FileDropZone } from './FileDropZone';

interface RunStatus {
  id: string;
  status: 'running' | 'pending' | 'completed' | 'failed';
  scorer: string;
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
  startedAt: string;
  finishedAt: string | null;
}

interface EvalResult {
  input: string;
  output: string;
  expected?: string;
  score?: number;
  passed: boolean;
}

type Scorer = 'exact' | 'contains' | 'regex' | 'llm';

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

export function EvalTab() {
  const { state } = useAppState();
  const { port } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [tasksContent, setTasksContent] = useState<string | null>(null);
  const [tasksName, setTasksName] = useState<string | null>(null);
  const [tasksSize, setTasksSize] = useState<number | null>(null);
  const [expectedContent, setExpectedContent] = useState<string | null>(null);
  const [expectedName, setExpectedName] = useState<string | null>(null);
  const [expectedSize, setExpectedSize] = useState<number | null>(null);
  const [concurrency, setConcurrency] = useState(4);
  const [scorer, setScorer] = useState<Scorer>('contains');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [runResults, setRunResults] = useState<EvalResult[] | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
          const res = await client.rpc.eval.get({ id });
          const run = res.run;
          setRunStatus({
            id: run.id,
            status: run.status,
            scorer: run.scorer,
            total: run.total,
            passed: run.passed,
            failed: run.failed,
            avgScore: run.avgScore,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          });
          if (run.status !== 'running' && run.status !== 'pending') {
            stopPolling();
            try {
              const output = await client.rpc.eval.output({ id });
              const lines = output.content
                .split('\n')
                .filter(Boolean)
                .map((line) => {
                  try {
                    return JSON.parse(line) as EvalResult;
                  } catch {
                    return null;
                  }
                })
                .filter((r): r is EvalResult => r !== null);
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
    if (!tasksContent || !expectedContent) return;
    try {
      const res = await client.rpc.eval.start({
        tasksJsonl: tasksContent,
        expectedJsonl: expectedContent,
        concurrency,
        scorer,
      });
      const run = res.run;
      setActiveRunId(run.id);
      setRunResults(null);
      setRunStatus({
        id: run.id,
        status: run.status,
        scorer: run.scorer,
        total: run.total,
        passed: run.passed,
        failed: run.failed,
        avgScore: run.avgScore,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      });
      pollRun(run.id);
    } catch {
      // best-effort
    }
  }, [client, tasksContent, expectedContent, concurrency, scorer, pollRun]);

  const handleDownload = useCallback(async () => {
    if (!activeRunId) return;
    try {
      const res = await client.rpc.eval.output({ id: activeRunId });
      await window.ethos.file.save({
        defaultName: `eval-${activeRunId.slice(0, 8)}.jsonl`,
        content: res.content,
      });
    } catch {
      // best-effort
    }
  }, [client, activeRunId]);

  const handleTasksFile = useCallback((content: string, name: string, size: number) => {
    setTasksContent(content);
    setTasksName(name);
    setTasksSize(size);
  }, []);

  const handleClearTasks = useCallback(() => {
    setTasksContent(null);
    setTasksName(null);
    setTasksSize(null);
  }, []);

  const handleExpectedFile = useCallback((content: string, name: string, size: number) => {
    setExpectedContent(content);
    setExpectedName(name);
    setExpectedSize(size);
  }, []);

  const handleClearExpected = useCallback(() => {
    setExpectedContent(null);
    setExpectedName(null);
    setExpectedSize(null);
  }, []);

  const progress =
    runStatus && runStatus.total > 0 ? (runStatus.passed + runStatus.failed) / runStatus.total : 0;
  const isRunning = runStatus?.status === 'running' || runStatus?.status === 'pending';
  const isDone = runStatus && !isRunning;
  const canStart = tasksContent && expectedContent && !isRunning;

  const scorerOptions: { value: Scorer; label: string }[] = [
    { value: 'contains', label: 'Contains' },
    { value: 'exact', label: 'Exact match' },
    { value: 'regex', label: 'Regex' },
    { value: 'llm', label: 'LLM judge' },
  ];

  function formatEta(): string {
    if (!runStatus || !isRunning) return '...';
    const done = runStatus.passed + runStatus.failed;
    if (done === 0) return '...';
    const elapsed = Date.now() - new Date(runStatus.startedAt).getTime();
    const rate = done / elapsed;
    const remaining = runStatus.total - done;
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
          label="Tasks (.jsonl)"
          fileName={tasksName}
          fileSize={tasksSize}
          onFile={handleTasksFile}
          onClear={handleClearTasks}
        />

        <div style={{ marginTop: 16 }}>
          <FileDropZone
            label="Expected outputs (.jsonl)"
            fileName={expectedName}
            fileSize={expectedSize}
            onFile={handleExpectedFile}
            onClear={handleClearExpected}
          />
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={fieldLabelStyle}>Scoring method</div>
          <select
            value={scorer}
            onChange={(e) => setScorer(e.target.value as Scorer)}
            style={selectStyle}
          >
            {scorerOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
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

        <button
          type="button"
          onClick={handleStart}
          disabled={!canStart}
          style={{
            width: '100%',
            marginTop: 24,
            padding: 10,
            borderRadius: 'var(--radius-sm)',
            border: 'none',
            background: canStart ? 'var(--blue)' : 'var(--bg-overlay)',
            color: canStart ? '#fff' : 'var(--text-tertiary)',
            fontSize: 13,
            fontWeight: 500,
            cursor: canStart ? 'pointer' : 'default',
            transition: 'background var(--motion-fast) var(--ease)',
          }}
        >
          Run eval
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
              Running&hellip; {runStatus ? runStatus.passed + runStatus.failed : 0}/
              {runStatus?.total ?? 0} completed
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
            <BatchResultsTable results={runResults} showExpected showScore />
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
              Eval results will appear here
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              Run an eval to see results.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
