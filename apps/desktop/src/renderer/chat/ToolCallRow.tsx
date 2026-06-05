import { useCallback, useState } from 'react';

interface ToolCallRowProps {
  toolCallId: string;
  name: string;
  args: unknown;
  status: 'running' | 'ok' | 'error';
  durationMs?: number;
  result?: string;
  progressMessage?: string;
}

function formatArgs(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function ToolCallRow({
  name,
  args,
  status,
  durationMs,
  result,
  progressMessage,
}: ToolCallRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [showFullResult, setShowFullResult] = useState(false);

  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const toggleFullResult = useCallback(() => setShowFullResult((v) => !v), []);

  const isError = status === 'error';
  const isRunning = status === 'running';

  const chipLabel = isRunning
    ? (progressMessage ?? name)
    : isError
      ? `${name} · error`
      : durationMs != null
        ? `${name} · ${formatDuration(durationMs)}`
        : name;

  const resultText = result ?? '';
  const resultTruncated = resultText.length > 2000 && !showFullResult;

  return (
    <div style={{ marginTop: 4, marginBottom: 4 }}>
      <button
        type="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => e.key === 'Enter' && toggle()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          cursor: 'pointer',
          userSelect: 'none',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          padding: '0 8px',
          font: 'inherit',
          color: isError ? 'var(--error)' : 'var(--text-secondary)',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1,
          }}
        >
          {'⚙'}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            whiteSpace: 'nowrap',
          }}
        >
          {chipLabel}
        </span>
        {isRunning && (
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              border: '1.5px solid var(--text-tertiary)',
              borderTopColor: 'transparent',
              animation: 'tool-spin 0.7s linear infinite',
            }}
          />
        )}
        <span
          style={{
            fontSize: 10,
            color: 'var(--text-tertiary)',
            transition: 'transform 160ms var(--ease)',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            marginLeft: 2,
          }}
        >
          {'▶'}
        </span>
      </button>
      <style>{`@keyframes tool-spin { to { transform: rotate(360deg); } }`}</style>
      <div
        style={{
          maxHeight: expanded ? 600 : 0,
          overflow: 'hidden',
          transition: 'max-height 240ms var(--ease)',
        }}
      >
        <div style={{ padding: '8px 0 8px 12px' }}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-tertiary)',
              marginBottom: 4,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            Args
          </div>
          <pre
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              background: 'var(--bg-overlay)',
              borderRadius: 'var(--radius-md)',
              padding: '8px 12px',
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-secondary)',
            }}
          >
            {formatArgs(args)}
          </pre>
          {resultText && (
            <>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--text-tertiary)',
                  marginBottom: 4,
                  marginTop: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                Result
              </div>
              <pre
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  background: 'var(--bg-overlay)',
                  borderRadius: 'var(--radius-md)',
                  padding: '8px 12px',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--text-secondary)',
                }}
              >
                {resultTruncated ? `${resultText.slice(0, 2000)}...` : resultText}
              </pre>
              {resultText.length > 2000 && (
                <button
                  type="button"
                  onClick={toggleFullResult}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    cursor: 'pointer',
                    padding: '4px 0',
                    marginTop: 4,
                  }}
                >
                  {showFullResult ? 'Show less' : 'Show more'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
