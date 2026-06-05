type BadgeVariant = 'green' | 'amber' | 'red' | 'dim' | 'blue';

const VARIANT_STYLES: Record<BadgeVariant, { color: string; bg: string }> = {
  green: { color: 'var(--green)', bg: 'rgba(74, 222, 128, 0.10)' },
  amber: { color: 'var(--amber)', bg: 'rgba(245, 158, 11, 0.10)' },
  red: { color: 'var(--red)', bg: 'rgba(248, 113, 113, 0.10)' },
  dim: { color: 'var(--text-tertiary)', bg: 'var(--bg-overlay)' },
  blue: { color: 'var(--blue)', bg: 'rgba(74, 158, 255, 0.10)' },
};

interface MonoBadgeProps {
  label: string;
  variant?: BadgeVariant;
}

export function MonoBadge({ label, variant = 'dim' }: MonoBadgeProps) {
  const styles = VARIANT_STYLES[variant];
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
      }}
    >
      {label}
    </span>
  );
}
