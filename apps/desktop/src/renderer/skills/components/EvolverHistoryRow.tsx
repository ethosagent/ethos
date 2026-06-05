interface EvolverHistoryRowProps {
  entry: {
    ranAt: string;
    rewritesProposed: number;
    newSkillsProposed: number;
    skipped: { kind: string; target: string; reason: string }[];
  };
  even?: boolean;
}

export function EvolverHistoryRow({ entry, even }: EvolverHistoryRowProps) {
  const date = new Date(entry.ranAt);
  const dateStr = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const total = entry.rewritesProposed + entry.newSkillsProposed;
  const badgeColor = total > 0 ? 'var(--green)' : 'var(--text-tertiary)';
  const badgeLabel = total > 0 ? 'proposed' : 'no changes';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 36,
        padding: '0 8px',
        background: even ? 'var(--bg-elevated)' : 'transparent',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-tertiary)',
          fontVariantNumeric: 'tabular-nums',
          width: 140,
          flexShrink: 0,
        }}
      >
        {dateStr}
      </span>
      <span
        style={{
          fontSize: 12,
          color: 'var(--text-secondary)',
          flex: 1,
        }}
      >
        {entry.rewritesProposed} rewrites, {entry.newSkillsProposed} new skills proposed
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          fontWeight: 500,
          color: badgeColor,
          backgroundColor: total > 0 ? 'rgba(74, 222, 128, 0.10)' : 'var(--bg-overlay)',
          padding: '2px 8px',
          borderRadius: 4,
          whiteSpace: 'nowrap',
        }}
      >
        {badgeLabel}
      </span>
    </div>
  );
}
