interface FilterChipProps {
  label: string;
  active: boolean;
  color?: string;
  onClick: () => void;
}

export function FilterChip({ label, active, color, onClick }: FilterChipProps) {
  const activeColor = color ?? 'var(--text-primary)';
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '3px 10px',
        borderRadius: 9999,
        border: `1px solid ${active ? activeColor : 'var(--border-strong)'}`,
        fontSize: 11,
        fontFamily: 'var(--font-display)',
        cursor: 'pointer',
        background: active
          ? color
            ? `color-mix(in srgb, ${activeColor} 15%, transparent)`
            : 'var(--bg-overlay)'
          : 'transparent',
        color: active ? activeColor : 'var(--text-secondary)',
        transition: 'all 80ms ease',
      }}
    >
      {label}
    </button>
  );
}
