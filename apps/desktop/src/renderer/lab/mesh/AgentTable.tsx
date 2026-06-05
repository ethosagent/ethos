import { StatusDot } from '../../ui/StatusDot';

export interface MeshAgent {
  agentId: string;
  capabilities: string[];
  activeSessions: number;
  lastSeenAt: string;
}

interface AgentTableProps {
  agents: MeshAgent[];
  onRegister: () => void;
}

function statusForAgent(agent: MeshAgent): 'connected' | 'connecting' | 'offline' {
  const elapsed = Date.now() - new Date(agent.lastSeenAt).getTime();
  if (elapsed > 30_000) return 'offline';
  if (elapsed > 15_000) return 'connecting';
  return 'connected';
}

function statusLabel(s: 'connected' | 'connecting' | 'offline'): string {
  if (s === 'connected') return 'Healthy';
  if (s === 'connecting') return 'Reconnecting';
  return 'Offline';
}

export function AgentTable({ agents, onRegister }: AgentTableProps) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-tertiary)',
          }}
        >
          STATUS
        </div>
        <button
          type="button"
          onClick={onRegister}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 'var(--radius-sm, 4px)',
            border: '1px solid var(--border-subtle)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Register agent
        </button>
      </div>

      {/* Column headers */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 28,
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <span style={{ ...headerStyle, flex: 1 }}>NODE</span>
        <span style={{ ...headerStyle, width: 120 }}>STATUS</span>
        <span style={{ ...headerStyle, width: 80 }}>SESSIONS</span>
        <span style={{ ...headerStyle, width: 80 }}>LATENCY</span>
      </div>

      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {agents.length === 0 ? (
          <div style={{ padding: '24px 0', fontSize: 13, color: 'var(--text-secondary)' }}>
            No agents registered.{' '}
            <button
              type="button"
              onClick={onRegister}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--info)',
                cursor: 'pointer',
                fontSize: 'inherit',
                padding: 0,
              }}
            >
              Register an agent &rarr;
            </button>
          </div>
        ) : (
          agents.map((agent) => {
            const s = statusForAgent(agent);
            return (
              <div
                key={agent.agentId}
                style={{
                  height: 36,
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <span
                  style={{
                    flex: 1,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {agent.agentId}
                </span>
                <span
                  style={{
                    width: 120,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexShrink: 0,
                  }}
                >
                  <StatusDot
                    color={
                      s === 'connected'
                        ? 'var(--success)'
                        : s === 'connecting'
                          ? 'var(--warning)'
                          : 'var(--error)'
                    }
                    size={8}
                  />
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {statusLabel(s)}
                  </span>
                </span>
                <span
                  style={{
                    width: 80,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    fontVariantNumeric: 'tabular-nums',
                    flexShrink: 0,
                  }}
                >
                  {agent.activeSessions}
                </span>
                <span
                  style={{
                    width: 80,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    fontVariantNumeric: 'tabular-nums',
                    flexShrink: 0,
                  }}
                >
                  &mdash;
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-tertiary)',
};
