import { useRef, useState } from 'react';

interface PendingSkillRowProps {
  candidate: {
    id: string;
    name: string;
    proposedAt: string;
    body: string;
    description: string | null;
  };
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function PendingSkillRow({ candidate, onApprove, onReject }: PendingSkillRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const handleApprove = () => {
    setDismissed(true);
    setTimeout(() => onApprove(candidate.id), 180);
  };

  const handleReject = () => {
    setDismissed(true);
    setTimeout(() => onReject(candidate.id), 180);
  };

  return (
    <div
      ref={rowRef}
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        overflow: 'hidden',
        opacity: dismissed ? 0 : 1,
        maxHeight: dismissed ? 0 : 600,
        transition: `opacity var(--motion-default) var(--ease), max-height var(--motion-default) var(--ease)`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          minHeight: 44,
          padding: '12px 16px',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {candidate.name}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-tertiary)',
              marginTop: 2,
            }}
          >
            proposed {relativeTime(candidate.proposedAt)}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--text-tertiary)',
            padding: '0 8px',
            lineHeight: 1,
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: `transform var(--motion-fast) var(--ease)`,
          }}
        >
          ▶
        </button>

        <button
          type="button"
          onClick={handleApprove}
          style={{
            background: 'none',
            border: '1px solid rgba(74, 158, 255, 0.3)',
            cursor: 'pointer',
            height: 28,
            padding: '0 12px',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--blue)',
          }}
        >
          Approve
        </button>

        <div style={{ width: 8 }} />

        <button
          type="button"
          onClick={handleReject}
          style={{
            background: 'none',
            border: '1px solid rgba(248, 113, 113, 0.3)',
            cursor: 'pointer',
            height: 28,
            padding: '0 12px',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--red)',
          }}
        >
          Reject
        </button>
      </div>

      <div
        style={{
          maxHeight: expanded ? 240 : 0,
          overflow: 'hidden',
          transition: `max-height var(--motion-slow) var(--ease)`,
        }}
      >
        <div style={{ padding: '0 16px 12px' }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.08em',
              textTransform: 'uppercase' as const,
              color: 'var(--text-tertiary)',
            }}
          >
            Proposed skill body
          </span>
          <pre
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-primary)',
              backgroundColor: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-md)',
              padding: 12,
              margin: '6px 0 0',
              maxHeight: 200,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {candidate.body}
          </pre>
        </div>
      </div>
    </div>
  );
}
