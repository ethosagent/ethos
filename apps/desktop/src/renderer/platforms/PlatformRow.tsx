import { StatusDot } from '../ui/StatusDot';

type PlatformStatus = 'connected' | 'warning' | 'error' | 'not-configured';

interface PlatformRowProps {
  icon: string;
  name: string;
  detail: string;
  status: PlatformStatus;
  statusText: string;
  onAction: () => void;
}

const statusColorMap: Record<PlatformStatus, string> = {
  connected: 'var(--success)',
  warning: 'var(--warning)',
  error: 'var(--error)',
  'not-configured': 'var(--text-tertiary)',
};

export function PlatformRow({
  icon,
  name,
  detail,
  status,
  statusText,
  onAction,
}: PlatformRowProps) {
  const actionLabel = status === 'not-configured' ? 'Connect' : 'Manage';

  return (
    // biome-ignore lint/a11y/useSemanticElements: row is a clickable container
    <div
      role="button"
      tabIndex={0}
      onClick={onAction}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onAction();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 56,
        padding: '0 16px',
        borderBottom: '1px solid var(--border-subtle)',
        cursor: 'pointer',
        transition: `background-color var(--motion-fast) var(--ease)`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.02)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      <span
        style={{
          width: 20,
          height: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          color: 'var(--text-secondary)',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ marginLeft: 12, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--text-primary)',
            lineHeight: 1.3,
          }}
        >
          {name}
        </div>
        {detail && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: 1.3,
            }}
          >
            {detail}
          </div>
        )}
      </div>
      <div style={{ flex: 1 }} />
      <StatusDot color={statusColorMap[status]} />
      <span
        style={{
          fontSize: 12,
          color: 'var(--text-secondary)',
          marginLeft: 8,
          whiteSpace: 'nowrap',
        }}
      >
        {statusText}
      </span>
      <span
        style={{
          fontSize: 14,
          color: 'var(--info)',
          marginLeft: 16,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {actionLabel} &rarr;
      </span>
    </div>
  );
}
