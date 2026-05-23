import { useCallback, useState } from 'react';

interface ThinkingBlockProps {
  thinking: string;
  durationMs?: number;
}

export function ThinkingBlock({ thinking, durationMs }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const durationLabel = durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : undefined;

  return (
    <div style={{ borderLeft: '2px solid var(--info)', paddingLeft: 12, margin: '8px 0' }}>
      <button
        type="button"
        onClick={toggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          color: 'var(--text-tertiary)',
          fontSize: 12,
          fontFamily: 'var(--font-display)',
        }}
      >
        <span
          style={{
            display: 'inline-block',
            fontSize: 12,
            transition: 'transform 160ms var(--ease)',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          {'▶'}
        </span>
        Thinking
        {durationLabel && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginLeft: 4 }}>
            {durationLabel}
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-display)',
            fontSize: 13,
            lineHeight: 1.5,
            marginTop: 8,
            whiteSpace: 'pre-wrap',
          }}
        >
          {thinking}
        </div>
      )}
    </div>
  );
}
