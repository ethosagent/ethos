type StatusName = 'connected' | 'connecting' | 'offline';

const STATUS_COLORS: Record<StatusName, string> = {
  connected: 'var(--green)',
  connecting: 'var(--amber)',
  offline: 'var(--red)',
};

interface StatusDotByNameProps {
  status: StatusName;
  color?: never;
  size?: number;
}

interface StatusDotByColorProps {
  status?: never;
  color: string;
  size?: number;
}

type StatusDotProps = StatusDotByNameProps | StatusDotByColorProps;

export function StatusDot(props: StatusDotProps) {
  const size = props.size ?? 8;
  const bg = props.color ?? STATUS_COLORS[props.status];
  const isConnecting = 'status' in props && props.status === 'connecting';

  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        flexShrink: 0,
        animation: isConnecting ? 'status-dot-pulse 1s ease-in-out infinite' : undefined,
      }}
    />
  );
}
