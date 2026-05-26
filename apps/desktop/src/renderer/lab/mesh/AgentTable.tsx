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
          AGENT REGISTRY
        </div>
        <button
          type="button"
          onClick={onRegister}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 4,
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

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 28,
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <span style={{ ...headerStyle, width: 200 }}>AGENT ID</span>
        <span style={{ ...headerStyle, flex: 1 }}>CAPABILITIES</span>
        <span style={{ ...headerStyle, width: 60 }}>STATUS</span>
        <span style={{ ...headerStyle, width: 120 }}>LAST SEEN</span>
      </div>

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
        agents.map((agent) => (
          <div
            key={agent.agentId}
            style={{
              height: 40,
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                color: 'var(--text-primary)',
                width: 200,
                flexShrink: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {agent.agentId}
            </span>
            <span
              style={{
                flex: 1,
                fontSize: 12,
                color: 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {agent.capabilities.join(', ')}
            </span>
            <span style={{ width: 60, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
              <StatusDot
                color={agent.activeSessions > 0 ? 'var(--success)' : 'var(--error)'}
                size={6}
              />
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-tertiary)',
                width: 120,
                flexShrink: 0,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {agent.lastSeenAt}
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
