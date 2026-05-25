interface StatusDotProps {
  color: string;
  size?: number;
}

export function StatusDot({ color, size = 6 }: StatusDotProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 'var(--radius-full)',
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}
