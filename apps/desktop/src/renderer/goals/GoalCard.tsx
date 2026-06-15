import type { GoalWire } from '@ethosagent/web-contracts';
import { ACTIVE_STATUSES, formatDuration, formatTime, statusConfig, truncate } from './status';

interface GoalCardProps {
  goal: GoalWire;
  selected: boolean;
  onSelect: (id: string) => void;
}

const COLUMNS = '1fr 120px 110px 130px 80px 70px';

export function GoalCard({ goal, selected, onSelect }: GoalCardProps) {
  const cfg = statusConfig(goal.status);
  const isActive = ACTIVE_STATUSES.has(goal.status);

  return (
    <button
      type="button"
      onClick={() => onSelect(goal.id)}
      style={{
        display: 'grid',
        gridTemplateColumns: COLUMNS,
        padding: '10px 16px',
        background: selected ? 'var(--bg-overlay)' : 'none',
        border: 'none',
        borderBottom: '1px solid var(--border-subtle)',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        color: 'var(--text-primary)',
        fontSize: 13,
        alignItems: 'center',
        transition: 'background-color var(--motion-fast)',
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = 'var(--ethos-hover)';
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          paddingRight: 12,
        }}
      >
        {truncate(goal.title || goal.goalText, 60)}
      </span>
      <span
        style={{
          color: 'var(--text-secondary)',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {goal.personalityId}
      </span>
      <span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            borderRadius: 'var(--radius-full)',
            fontSize: 11,
            fontWeight: 500,
            color: cfg.color,
            background: `color-mix(in srgb, ${cfg.color} 15%, transparent)`,
          }}
        >
          {isActive ? (
            <span
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: cfg.color,
                animation: 'goals-pulse 1.5s ease-in-out infinite',
              }}
            />
          ) : (
            <span>{cfg.icon}</span>
          )}
          {cfg.label}
        </span>
      </span>
      <span
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}
      >
        {formatTime(goal.startedAt)}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatDuration(goal.startedAt, goal.completedAt)}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {goal.costUsd != null ? `$${goal.costUsd.toFixed(2)}` : '—'}
      </span>
    </button>
  );
}
