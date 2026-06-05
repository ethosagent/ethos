import type { BatchRunInfo, EvalRunInfo, EvalScorer } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { rpc } from '../rpc';

// Lab — Batch / Eval. Redesign (11-batch-eval.md).
//
// Two outer tabs (Batch | Eval). Each tab uses a two-panel layout:
//   Left config panel (280px): dataset drop zone, personality select,
//     concurrency, retries, run button.
//   Right results panel (flex): empty state → progress → results table.

type Tab = 'batch' | 'eval';

/* ── Shared utilities ────────────────────────────────────────────── */

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleString();
}

/* ── FileDropZone (inline, per spec) ─────────────────────────────── */

interface FileDropZoneProps {
  label: string;
  fileName: string | null;
  fileSize: number | null;
  onFile: (content: string, name: string, size: number) => void;
  onClear: () => void;
}

function FileDropZone({ label, fileName, fileSize, onFile, onClear }: FileDropZoneProps) {
  const [hovering, setHovering] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const readFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          onFile(reader.result, file.name, file.size);
        }
      };
      reader.readAsText(file);
    },
    [onFile],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHovering(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHovering(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setHovering(false);
      const file = e.dataTransfer.files[0];
      if (file) readFile(file);
    },
    [readFile],
  );

  const handleBrowse = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) readFile(file);
    },
    [readFile],
  );

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div>
      <div className="batch-field-label">{label}</div>
      <input
        ref={inputRef}
        type="file"
        accept=".jsonl"
        onChange={handleInputChange}
        style={{ display: 'none' }}
      />
      {fileName ? (
        <div className="batch-file-selected">
          <div className="batch-file-info">
            <span className="batch-file-name">{fileName}</span>
            {fileSize != null && <span className="batch-file-size">{formatSize(fileSize)}</span>}
          </div>
          <button type="button" className="batch-file-clear" onClick={onClear}>
            &times;
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={`batch-dropzone ${hovering ? 'batch-dropzone--active' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleBrowse}
        >
          <span className="batch-dropzone-icon">&#8593;</span>
          <span className="batch-dropzone-primary">Drop a JSONL file or click to upload</span>
          <span className="batch-dropzone-secondary">One JSON object per line</span>
        </button>
      )}
    </div>
  );
}

/* ── MonoBadge ───────────────────────────────────────────────────── */

function MonoBadge({
  color,
  children,
}: {
  color: 'green' | 'red' | 'blue' | 'dim';
  children: React.ReactNode;
}) {
  return <span className={`badge badge-${color}`}>{children}</span>;
}

/* ── ProgressBar (4px, blue) ─────────────────────────────────────── */

function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div className="batch-progress-track">
      <div className="batch-progress-fill" style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}

/* ── Batch tab content ───────────────────────────────────────────── */

interface PersonalityOption {
  id: string;
  name: string;
}

function BatchTabContent() {
  const qc = useQueryClient();
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [personalityId, setPersonalityId] = useState('');
  const [concurrency, setConcurrency] = useState(4);
  const [maxRetries, setMaxRetries] = useState(2);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  const personalities: PersonalityOption[] = (personalitiesQuery.data?.items ?? []).map(
    (p: { id: string; name: string }) => ({ id: p.id, name: p.name }),
  );

  useEffect(() => {
    if (personalities.length > 0 && !personalityId) {
      const defaultId = personalitiesQuery.data?.defaultId;
      setPersonalityId(defaultId ?? personalities[0].id);
    }
  }, [personalities, personalityId, personalitiesQuery.data?.defaultId]);

  const listQuery = useQuery({
    queryKey: ['batch', 'list'],
    queryFn: () => rpc.batch.list(),
    refetchInterval: 2000,
  });

  const runs = listQuery.data?.runs ?? [];
  const activeRun = runs.find(
    (r: BatchRunInfo) => r.status === 'running' || r.status === 'pending',
  );

  const startMut = useMutation({
    mutationFn: (values: {
      tasksJsonl: string;
      concurrency: number;
      defaultPersonalityId: string;
    }) => rpc.batch.start(values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['batch', 'list'] });
    },
  });

  const handleStart = useCallback(() => {
    if (!fileContent) return;
    startMut.mutate({
      tasksJsonl: fileContent,
      concurrency,
      defaultPersonalityId: personalityId,
    });
  }, [fileContent, concurrency, personalityId, startMut]);

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

  const isRunning = startMut.isPending || activeRun != null;
  const canStart = fileContent != null && !isRunning;

  return (
    <div className="batch-two-panel">
      {/* Left config panel */}
      <div className="batch-config-panel">
        <FileDropZone
          label="Dataset"
          fileName={fileName}
          fileSize={fileSize}
          onFile={handleFile}
          onClear={handleClearFile}
        />

        <div style={{ marginTop: 16 }}>
          <div className="batch-field-label">Personality</div>
          <select
            className="batch-select"
            value={personalityId}
            onChange={(e) => setPersonalityId(e.target.value)}
          >
            {personalities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="batch-field-label">Concurrency</div>
          <input
            type="number"
            className="batch-number-input"
            min={1}
            max={20}
            value={concurrency}
            onChange={(e) => setConcurrency(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="batch-field-label">Max retries</div>
          <input
            type="number"
            className="batch-number-input"
            min={0}
            max={5}
            value={maxRetries}
            onChange={(e) => setMaxRetries(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
          />
        </div>

        <button type="button" className="batch-run-btn" disabled={!canStart} onClick={handleStart}>
          Run batch
        </button>
      </div>

      {/* Right results panel */}
      <div className="batch-results-panel">
        {activeRun ? (
          <BatchProgressView run={activeRun} />
        ) : runs.length > 0 ? (
          <BatchResultsList runs={runs} expandedRow={expandedRow} onToggleRow={setExpandedRow} />
        ) : (
          <div className="batch-empty-state">
            <div className="batch-empty-primary">Results will appear here</div>
            <div className="batch-empty-secondary">Run a batch to see results.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function BatchProgressView({ run }: { run: BatchRunInfo }) {
  const finished = run.completed + run.failed;
  const pct = run.total === 0 ? 0 : finished / run.total;

  return (
    <div className="batch-progress-section">
      <div className="batch-progress-label">
        Running&hellip; {finished}/{run.total} completed
      </div>
      <ProgressBar value={pct} />
      <button
        type="button"
        className="btn btn-ghost"
        style={{ marginTop: 8, alignSelf: 'flex-start' }}
      >
        Cancel
      </button>
    </div>
  );
}

function BatchResultsList({
  runs,
  expandedRow,
  onToggleRow,
}: {
  runs: BatchRunInfo[];
  expandedRow: number | null;
  onToggleRow: (idx: number | null) => void;
}) {
  const latestRun = runs[0];
  return (
    <div>
      <div className="batch-results-header">
        <span className="batch-results-label">Results</span>
        <span className="batch-results-ts">{formatRelative(latestRun.startedAt)}</span>
      </div>
      <div className="batch-results-table">
        <div className="batch-results-row batch-results-row--header">
          <span className="batch-col-num">#</span>
          <span className="batch-col-id">Run</span>
          <span className="batch-col-status">Status</span>
          <span className="batch-col-progress">Progress</span>
          <span className="batch-col-started">Started</span>
          <span className="batch-col-actions" />
        </div>
        {runs.map((run, idx) => {
          const finished = run.completed + run.failed;
          const pct = run.total === 0 ? 0 : Math.round((finished / run.total) * 100);
          return (
            <div key={run.id}>
              <button
                type="button"
                className="batch-results-row batch-results-row--data"
                onClick={() => onToggleRow(expandedRow === idx ? null : idx)}
              >
                <span className="batch-col-num batch-mono">{idx + 1}</span>
                <span className="batch-col-id batch-mono">{run.id.slice(0, 8)}</span>
                <span className="batch-col-status">
                  <MonoBadge
                    color={
                      run.status === 'completed'
                        ? 'green'
                        : run.status === 'failed'
                          ? 'red'
                          : run.status === 'running'
                            ? 'blue'
                            : 'dim'
                    }
                  >
                    {run.status}
                  </MonoBadge>
                </span>
                <span className="batch-col-progress batch-mono">
                  {pct}% ({finished}/{run.total})
                </span>
                <span className="batch-col-started batch-mono">
                  {formatRelative(run.startedAt)}
                </span>
                <span className="batch-col-actions">
                  <BatchDownloadBtn runId={run.id} />
                </span>
              </button>
              {expandedRow === idx && (
                <div className="batch-results-expanded">
                  <div className="batch-expanded-detail">
                    {run.completed} done &middot; {run.failed} failed &middot; {run.skipped} skipped
                    &middot; {run.total} total
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BatchDownloadBtn({ runId }: { runId: string }) {
  const downloadMut = useMutation({
    mutationFn: () => rpc.batch.output({ id: runId }),
    onSuccess: (result) => {
      if (!result.content) return;
      const blob = new Blob([result.content], { type: 'application/jsonl' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `batch-${runId}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  return (
    <button
      type="button"
      className="btn btn-ghost"
      style={{ fontSize: 11, padding: '2px 8px' }}
      onClick={(e) => {
        e.stopPropagation();
        downloadMut.mutate();
      }}
    >
      {downloadMut.isPending ? '...' : 'Download'}
    </button>
  );
}

/* ── Eval tab content ────────────────────────────────────────────── */

function EvalTabContent() {
  const qc = useQueryClient();
  const [tasksContent, setTasksContent] = useState<string | null>(null);
  const [tasksName, setTasksName] = useState<string | null>(null);
  const [tasksSize, setTasksSize] = useState<number | null>(null);
  const [expectedContent, setExpectedContent] = useState<string | null>(null);
  const [expectedName, setExpectedName] = useState<string | null>(null);
  const [expectedSize, setExpectedSize] = useState<number | null>(null);
  const [scorer, setScorer] = useState<EvalScorer>('contains');
  const [concurrency, setConcurrency] = useState(4);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const listQuery = useQuery({
    queryKey: ['eval', 'list'],
    queryFn: () => rpc.eval.list(),
    refetchInterval: 2000,
  });

  const runs = listQuery.data?.runs ?? [];
  const activeRun = runs.find((r: EvalRunInfo) => r.status === 'running' || r.status === 'pending');

  const startMut = useMutation({
    mutationFn: (values: {
      tasksJsonl: string;
      expectedJsonl: string;
      scorer: EvalScorer;
      concurrency: number;
    }) => rpc.eval.start(values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eval', 'list'] });
    },
  });

  const handleStart = useCallback(() => {
    if (!tasksContent || !expectedContent) return;
    startMut.mutate({
      tasksJsonl: tasksContent,
      expectedJsonl: expectedContent,
      scorer,
      concurrency,
    });
  }, [tasksContent, expectedContent, scorer, concurrency, startMut]);

  const isRunning = startMut.isPending || activeRun != null;
  const canStart = tasksContent != null && expectedContent != null && !isRunning;

  const scorerOptions: { value: EvalScorer; label: string }[] = [
    { value: 'contains', label: 'Contains' },
    { value: 'exact', label: 'Exact match' },
    { value: 'regex', label: 'Regex' },
    { value: 'llm', label: 'LLM judge' },
  ];

  return (
    <div className="batch-two-panel">
      {/* Left config panel */}
      <div className="batch-config-panel">
        <FileDropZone
          label="Tasks dataset"
          fileName={tasksName}
          fileSize={tasksSize}
          onFile={(content, name, size) => {
            setTasksContent(content);
            setTasksName(name);
            setTasksSize(size);
          }}
          onClear={() => {
            setTasksContent(null);
            setTasksName(null);
            setTasksSize(null);
          }}
        />

        <div style={{ marginTop: 16 }}>
          <FileDropZone
            label="Expected outputs"
            fileName={expectedName}
            fileSize={expectedSize}
            onFile={(content, name, size) => {
              setExpectedContent(content);
              setExpectedName(name);
              setExpectedSize(size);
            }}
            onClear={() => {
              setExpectedContent(null);
              setExpectedName(null);
              setExpectedSize(null);
            }}
          />
        </div>

        <div style={{ marginTop: 16 }}>
          <div className="batch-field-label">Scoring method</div>
          <select
            className="batch-select"
            value={scorer}
            onChange={(e) => setScorer(e.target.value as EvalScorer)}
          >
            {scorerOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="batch-field-label">Concurrency</div>
          <input
            type="number"
            className="batch-number-input"
            min={1}
            max={20}
            value={concurrency}
            onChange={(e) => setConcurrency(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
          />
        </div>

        <button type="button" className="batch-run-btn" disabled={!canStart} onClick={handleStart}>
          Run eval
        </button>
      </div>

      {/* Right results panel */}
      <div className="batch-results-panel">
        {activeRun ? (
          <EvalProgressView run={activeRun} />
        ) : runs.length > 0 ? (
          <EvalResultsList runs={runs} expandedRow={expandedRow} onToggleRow={setExpandedRow} />
        ) : (
          <div className="batch-empty-state">
            <div className="batch-empty-primary">Eval results will appear here</div>
            <div className="batch-empty-secondary">Run an eval to see results.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function EvalProgressView({ run }: { run: EvalRunInfo }) {
  const finished = run.passed + run.failed;
  const pct = run.total === 0 ? 0 : finished / run.total;

  return (
    <div className="batch-progress-section">
      <div className="batch-progress-label">
        Running&hellip; {finished}/{run.total} completed
      </div>
      <ProgressBar value={pct} />
      <button
        type="button"
        className="btn btn-ghost"
        style={{ marginTop: 8, alignSelf: 'flex-start' }}
      >
        Cancel
      </button>
    </div>
  );
}

function EvalResultsList({
  runs,
  expandedRow,
  onToggleRow,
}: {
  runs: EvalRunInfo[];
  expandedRow: number | null;
  onToggleRow: (idx: number | null) => void;
}) {
  const latestRun = runs[0];
  return (
    <div>
      <div className="batch-results-header">
        <span className="batch-results-label">Results</span>
        <span className="batch-results-ts">{formatRelative(latestRun.startedAt)}</span>
      </div>
      <div className="batch-results-table">
        <div className="batch-results-row batch-results-row--header">
          <span className="batch-col-num">#</span>
          <span className="batch-col-id">Run</span>
          <span className="batch-col-status">Status</span>
          <span className="batch-col-score">Score</span>
          <span className="batch-col-progress">Progress</span>
          <span className="batch-col-started">Started</span>
          <span className="batch-col-actions" />
        </div>
        {runs.map((run, idx) => {
          const finished = run.passed + run.failed;
          const pct = run.total === 0 ? 0 : Math.round((finished / run.total) * 100);
          return (
            <div key={run.id}>
              <button
                type="button"
                className="batch-results-row batch-results-row--data"
                onClick={() => onToggleRow(expandedRow === idx ? null : idx)}
              >
                <span className="batch-col-num batch-mono">{idx + 1}</span>
                <span className="batch-col-id batch-mono">{run.id.slice(0, 8)}</span>
                <span className="batch-col-status">
                  <MonoBadge
                    color={
                      run.status === 'completed'
                        ? 'green'
                        : run.status === 'failed'
                          ? 'red'
                          : run.status === 'running'
                            ? 'blue'
                            : 'dim'
                    }
                  >
                    {run.status}
                  </MonoBadge>
                </span>
                <span className="batch-col-score batch-mono">
                  {(run.avgScore * 100).toFixed(1)}%
                </span>
                <span className="batch-col-progress batch-mono">
                  {pct}% ({finished}/{run.total})
                </span>
                <span className="batch-col-started batch-mono">
                  {formatRelative(run.startedAt)}
                </span>
                <span className="batch-col-actions">
                  <EvalDownloadBtn runId={run.id} />
                </span>
              </button>
              {expandedRow === idx && (
                <div className="batch-results-expanded">
                  <div className="batch-expanded-detail">
                    {run.passed} pass &middot; {run.failed} fail &middot; {run.total} total &middot;
                    scorer: {run.scorer}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EvalDownloadBtn({ runId }: { runId: string }) {
  const downloadMut = useMutation({
    mutationFn: () => rpc.eval.output({ id: runId }),
    onSuccess: (result) => {
      if (!result.content) return;
      const blob = new Blob([result.content], { type: 'application/jsonl' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `eval-${runId}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  return (
    <button
      type="button"
      className="btn btn-ghost"
      style={{ fontSize: 11, padding: '2px 8px' }}
      onClick={(e) => {
        e.stopPropagation();
        downloadMut.mutate();
      }}
    >
      {downloadMut.isPending ? '...' : 'Download'}
    </button>
  );
}

/* ── Main export ─────────────────────────────────────────────────── */

const tabs: { value: Tab; label: string }[] = [
  { value: 'batch', label: 'Batch' },
  { value: 'eval', label: 'Eval' },
];

export function Batch() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: Tab = tabParam === 'eval' ? 'eval' : 'batch';

  const setTab = useCallback(
    (tab: Tab) => {
      setSearchParams(tab === 'batch' ? {} : { tab });
    },
    [setSearchParams],
  );

  return (
    <div className="batch-page">
      <div className="batch-tab-bar">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={`batch-tab ${activeTab === tab.value ? 'batch-tab--active' : ''}`}
            onClick={() => setTab(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="batch-body">
        {activeTab === 'batch' ? <BatchTabContent /> : <EvalTabContent />}
      </div>
    </div>
  );
}
