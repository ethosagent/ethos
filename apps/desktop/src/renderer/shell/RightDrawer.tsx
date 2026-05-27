import type {
  DrawerNotification,
  DrawerState,
  DrawerUsage,
  ToolStreamEntry,
} from './useDrawerStream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
  padding: '10px 12px 4px',
  fontFamily: 'var(--font-display)',
};

const emptyHintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-tertiary)',
  fontFamily: 'var(--font-display)',
  padding: '6px 12px 12px',
};

function ToolRow({ entry }: { entry: ToolStreamEntry }) {
  const statusColor =
    entry.status === 'running'
      ? 'var(--accent)'
      : entry.status === 'ok'
        ? 'var(--success)'
        : 'var(--error)';
  const statusIcon = entry.status === 'running' ? '●' : entry.status === 'ok' ? '✓' : '✗';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px' }}>
      <span
        style={{
          fontSize: 10,
          color: statusColor,
          width: 12,
          textAlign: 'center',
          flexShrink: 0,
        }}
      >
        {statusIcon}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.toolName}
      </span>
      {entry.durationMs != null && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
            flexShrink: 0,
          }}
        >
          {entry.durationMs < 1000
            ? `${entry.durationMs}ms`
            : `${(entry.durationMs / 1000).toFixed(1)}s`}
        </span>
      )}
    </div>
  );
}

function NotificationRow({
  notification,
  onNavigate,
}: {
  notification: DrawerNotification;
  onNavigate: (route: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(notification.deepLink)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 12px',
        width: '100%',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <span
        style={{ fontFamily: 'var(--font-display)', fontSize: 12, color: 'var(--text-primary)' }}
      >
        {notification.summary}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>
        {formatRelative(notification.receivedAt)}
      </span>
    </button>
  );
}

function UsageSection({ usage }: { usage: DrawerUsage }) {
  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    fontFamily: 'var(--font-display)',
    color: 'var(--text-tertiary)',
  };
  const valueStyle: React.CSSProperties = {
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
  };

  return (
    <dl
      style={{
        padding: '6px 12px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        margin: 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <dt style={labelStyle}>Input</dt>
        <dd style={{ ...valueStyle, margin: 0 }}>{formatTokens(usage.inputTokens)}</dd>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <dt style={labelStyle}>Output</dt>
        <dd style={{ ...valueStyle, margin: 0 }}>{formatTokens(usage.outputTokens)}</dd>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <dt style={labelStyle}>Cost</dt>
        <dd style={{ ...valueStyle, margin: 0 }}>{formatCost(usage.estimatedCostUsd)}</dd>
      </div>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface RightDrawerProps {
  state: DrawerState;
  onNavigate: (route: string) => void;
  onClose: () => void;
}

export function RightDrawer({ state, onNavigate, onClose }: RightDrawerProps) {
  return (
    <aside
      style={{
        width: 260,
        minWidth: 260,
        height: '100%',
        background: 'var(--bg-elevated)',
        borderLeft: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'var(--font-display)',
            color: 'var(--text-primary)',
          }}
        >
          Activity
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-tertiary)',
            fontSize: 16,
            cursor: 'pointer',
            padding: '0 4px',
          }}
        >
          ×
        </button>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Tool Stream section */}
        <div style={sectionHeaderStyle}>Tool stream</div>
        {state.toolStream.length === 0 ? (
          <div style={emptyHintStyle}>No tool calls yet</div>
        ) : (
          state.toolStream.map((entry) => <ToolRow key={entry.toolCallId} entry={entry} />)
        )}

        {/* Notifications section */}
        <div
          style={{
            ...sectionHeaderStyle,
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 10,
          }}
        >
          Notifications
        </div>
        {state.notifications.length === 0 ? (
          <div style={emptyHintStyle}>No notifications</div>
        ) : (
          state.notifications.map((n) => (
            <NotificationRow key={n.id} notification={n} onNavigate={onNavigate} />
          ))
        )}

        {/* Usage section */}
        <div
          style={{
            ...sectionHeaderStyle,
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 10,
          }}
        >
          Usage
        </div>
        {state.usage == null ? (
          <div style={emptyHintStyle}>No usage data yet</div>
        ) : (
          <UsageSection usage={state.usage} />
        )}
      </div>
    </aside>
  );
}
