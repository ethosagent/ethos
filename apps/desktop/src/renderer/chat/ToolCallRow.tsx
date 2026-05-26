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

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

function formatArgs(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

const statusIcons: Record<string, { icon: string; color: string }> = {
  running: { icon: '⏳', color: 'var(--text-tertiary)' },
  ok: { icon: '✓', color: 'var(--success)' },
  error: { icon: '✗', color: 'var(--error)' },
};

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

  const statusInfo = statusIcons[status] ?? statusIcons.running;
  const argsStr = formatArgs(args);
  const preview = status === 'running' && progressMessage ? progressMessage : truncate(argsStr, 80);
  const durationLabel = durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : '';
  const resultText = result ?? '';
  const resultTruncated = resultText.length > 2000 && !showFullResult;

  return (
    <div style={{ marginLeft: 12, marginTop: 4, marginBottom: 4 }}>
      <button
        type="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => e.key === 'Enter' && toggle()}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 36,
          cursor: 'pointer',
          userSelect: 'none',
          background: 'none',
          border: 'none',
          padding: 0,
          width: '100%',
          font: 'inherit',
          color: 'inherit',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 14, color: statusInfo.color, width: 18, textAlign: 'center' }}>
          {statusInfo.icon}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-secondary)',
            flexShrink: 0,
          }}
        >
          {name}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {preview}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
            flexShrink: 0,
          }}
        >
          {durationLabel}
        </span>
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-tertiary)',
            transition: 'transform 160ms var(--ease)',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          {'▶'}
        </span>
      </button>
      <div
        style={{
          maxHeight: expanded ? 600 : 0,
          overflow: 'hidden',
          transition: 'max-height 240ms var(--ease)',
        }}
      >
        <div style={{ padding: '8px 0 8px 26px' }}>
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
            {JSON.stringify(args, null, 2)}
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
