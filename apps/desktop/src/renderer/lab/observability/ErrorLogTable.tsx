import { useState } from 'react';

interface ErrorEntry {
  timestamp: string;
  personality: string;
  tool: string;
  error: string;
}

interface ErrorLogTableProps {
  errors: ErrorEntry[];
}

const DEFAULT_LIMIT = 20;

export function ErrorLogTable({ errors }: ErrorLogTableProps) {
  const [showAll, setShowAll] = useState(false);

  const visible = showAll ? errors : errors.slice(0, DEFAULT_LIMIT);
  const hasMore = errors.length > DEFAULT_LIMIT;

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
        RECENT ERRORS
      </div>
      {visible.map((entry) => (
        <div
          key={`${entry.timestamp}-${entry.tool}-${entry.error.slice(0, 30)}`}
          style={{
            height: 36,
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-tertiary)',
              width: 140,
              flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {entry.timestamp}
          </span>
          <span
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              width: 100,
              flexShrink: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.personality}
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-secondary)',
              width: 120,
              flexShrink: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.tool}
          </span>
          <span
            style={{
              fontSize: 12,
              color: 'var(--error)',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={entry.error}
          >
            {entry.error}
          </span>
        </div>
      ))}
      {hasMore && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--info)',
            fontSize: 12,
            cursor: 'pointer',
            padding: '8px 0',
          }}
        >
          {showAll ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}
