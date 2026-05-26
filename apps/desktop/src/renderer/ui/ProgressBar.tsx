interface ProgressBarProps {
  value: number;
  height?: number;
  color?: string;
}

export function ProgressBar({ value, height = 4, color = 'var(--success)' }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(1, value));

  return (
    <div
      style={{
        width: '100%',
        height,
        backgroundColor: 'var(--bg-overlay)',
        borderRadius: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          backgroundColor: color,
          transition: 'width var(--motion-default) var(--ease)',
        }}
      />
    </div>
  );
}
