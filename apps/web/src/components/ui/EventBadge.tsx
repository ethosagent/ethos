type EventType =
  | 'tool_start'
  | 'tool_end'
  | 'done'
  | 'error'
  | 'tool.approval_required'
  | 'cron.fired';

const BADGE_STYLES: Record<EventType, { bg: string; color: string }> = {
  tool_start: { bg: 'rgba(74,158,255,0.15)', color: 'var(--blue)' },
  tool_end: { bg: 'rgba(74,158,255,0.15)', color: 'var(--blue)' },
  done: { bg: 'rgba(148,163,184,0.15)', color: 'var(--slate)' },
  error: { bg: 'rgba(248,113,113,0.15)', color: 'var(--red)' },
  'tool.approval_required': { bg: 'rgba(245,158,11,0.15)', color: 'var(--amber)' },
  'cron.fired': { bg: 'rgba(232,121,249,0.15)', color: 'var(--purple)' },
};

interface EventBadgeProps {
  eventType: EventType;
  label?: string;
}

export function EventBadge({ eventType, label }: EventBadgeProps) {
  const styles = BADGE_STYLES[eventType] ?? BADGE_STYLES.done;
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        fontWeight: 500,
        color: styles.color,
        backgroundColor: styles.bg,
        padding: '2px 8px',
        borderRadius: 'var(--radius-sm)',
        whiteSpace: 'nowrap',
        minWidth: 90,
        display: 'inline-block',
        textAlign: 'center',
      }}
    >
      {label ?? eventType}
    </span>
  );
}
