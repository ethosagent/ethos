interface EvolverHistoryRowProps {
  entry: {
    ranAt: string;
    rewritesProposed: number;
    newSkillsProposed: number;
    skipped: { kind: string; target: string; reason: string }[];
  };
}

export function EvolverHistoryRow({ entry }: EvolverHistoryRowProps) {
  const date = new Date(entry.ranAt);
  const dateStr = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 36,
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-tertiary)',
          fontVariantNumeric: 'tabular-nums',
          width: 120,
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
          color: 'var(--text-tertiary)',
        }}
      >
        {entry.skipped.length} skipped
      </span>
    </div>
  );
}
