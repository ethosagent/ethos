interface StatusDotProps {
  status: 'connected' | 'connecting' | 'offline';
  size?: number;
}

const STATUS_COLORS = {
  connected: 'var(--green)',
  connecting: 'var(--amber)',
  offline: 'var(--red)',
};

export function StatusDot({ status, size = 8 }: StatusDotProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: STATUS_COLORS[status],
        flexShrink: 0,
        animation: status === 'connecting' ? 'status-dot-pulse 1s ease-in-out infinite' : undefined,
      }}
    />
  );
}
