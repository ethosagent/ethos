import { useCallback, useState } from 'react';
import { SectionLabel } from '../ui/SectionLabel';

export function SessionMemoryContext() {
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  return (
    <div>
      {/* Toggle bar */}
      <button
        type="button"
        onClick={toggle}
        style={{
          width: '100%',
          height: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: '1px solid var(--border-subtle)',
          border: 'none',
          borderTopStyle: 'solid',
          borderTopWidth: 1,
          borderTopColor: 'var(--border-subtle)',
          background: 'none',
          padding: '0 0',
          cursor: 'pointer',
        }}
      >
        <SectionLabel>WHAT THE AGENT SEES THIS SESSION</SectionLabel>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-display)',
            }}
          >
            {expanded ? 'Hide' : 'Show'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {expanded ? '▼' : '▶'}
          </span>
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: 16,
            marginTop: 8,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--text-secondary)',
              marginBottom: 12,
              fontFamily: 'var(--font-display)',
            }}
          >
            System prompt memory injection
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
              maxHeight: 200,
              overflowY: 'auto',
            }}
          >
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
              No memory injected into the current session.
            </span>
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              fontStyle: 'italic',
              marginTop: 12,
              fontFamily: 'var(--font-display)',
            }}
          >
            Changes to memory take effect at the start of the next conversation.
          </div>
        </div>
      )}
    </div>
  );
}
