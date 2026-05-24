export interface ApiKey {
  id: string;
  prefix: string;
  name: string;
  scopes: string[];
  allowedOrigins: string[];
  createdAt: string;
  lastUsed: string | null;
  revokedAt: string | null;
}

interface KeyTableProps {
  keys: ApiKey[];
  onRevoke: (id: string) => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function KeyTable({ keys, onRevoke }: KeyTableProps) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 28,
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <span style={{ ...headerStyle, width: 160 }}>NAME</span>
        <span style={{ ...headerStyle, flex: 1 }}>SCOPES</span>
        <span style={{ ...headerStyle, width: 100 }}>CREATED</span>
        <span style={{ ...headerStyle, width: 80 }}>LAST USED</span>
        <span style={{ ...headerStyle, width: 60 }}>ACTIONS</span>
      </div>

      {keys.length === 0 ? (
        <div style={{ padding: '24px 0', fontSize: 13, color: 'var(--text-secondary)' }}>
          No API keys. Create one to allow external access to your Ethos instance.
        </div>
      ) : (
        keys.map((key) => (
          <div
            key={key.id}
            style={{
              height: 40,
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                fontSize: 14,
                color: 'var(--text-primary)',
                width: 160,
                flexShrink: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {key.name}
            </span>
            <span
              style={{
                flex: 1,
                display: 'inline-flex',
                gap: 4,
                overflow: 'hidden',
                flexWrap: 'wrap',
              }}
            >
              {key.scopes.map((scope) => (
                <span key={scope} style={chipStyle}>
                  {scope}
                </span>
              ))}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-tertiary)',
                width: 100,
                flexShrink: 0,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {key.createdAt}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-tertiary)',
                width: 80,
                flexShrink: 0,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {key.lastUsed ? relativeTime(key.lastUsed) : 'Never'}
            </span>
            <span style={{ width: 60, flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Revoke this API key?')) {
                    onRevoke(key.id);
                  }
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--error)',
                  fontSize: 12,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                Revoke
              </button>
            </span>
          </div>
        ))
      )}
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--text-tertiary)',
};

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  background: 'var(--bg-overlay)',
  borderRadius: 4,
  padding: '6px 8px',
  color: 'var(--text-primary)',
};
