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
      className="obs-filter-chip"
      style={
        active
          ? {
              background: color
                ? `color-mix(in srgb, ${activeColor} 15%, transparent)`
                : 'var(--bg-overlay)',
              borderColor: activeColor,
              color: activeColor,
            }
          : undefined
      }
    >
      {label}
    </button>
  );
}
