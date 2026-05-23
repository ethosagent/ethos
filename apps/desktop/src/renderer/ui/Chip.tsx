interface ChipProps {
  label: string;
  variant: 'success' | 'info' | 'warning' | 'neutral';
}

const variantStyles: Record<ChipProps['variant'], { color: string; bg: string }> = {
  success: { color: 'var(--success)', bg: 'var(--bg-overlay)' },
  info: { color: 'var(--info)', bg: 'var(--bg-overlay)' },
  warning: { color: 'var(--warning)', bg: 'var(--bg-overlay)' },
  neutral: { color: 'var(--text-secondary)', bg: 'var(--bg-overlay)' },
};

export function Chip({ label, variant }: ChipProps) {
  const styles = variantStyles[variant];
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
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
