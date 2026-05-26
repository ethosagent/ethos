import type { McpServerInfo } from './McpPage';
import { McpServerRow } from './McpServerRow';

interface McpServerTableProps {
  servers: McpServerInfo[];
  onRowClick: (name: string) => void;
  onReconnect: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
  onAddServer: () => void;
}

const columnHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
};

export function McpServerTable({
  servers,
  onRowClick,
  onReconnect,
  onRename,
  onDelete,
  onAddServer,
}: McpServerTableProps) {
  if (servers.length === 0) {
    return (
      <div style={{ paddingTop: 48, textAlign: 'center' }}>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>
          No MCP servers configured.
        </div>
        <button
          type="button"
          onClick={onAddServer}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--info)',
            fontSize: 14,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {'Add server →'}
        </button>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 32,
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ ...columnHeaderStyle, flex: 1 }}>Name</div>
        <div style={{ ...columnHeaderStyle, width: 100 }}>Transport</div>
        <div style={{ ...columnHeaderStyle, width: 120 }}>Status</div>
        <div style={{ ...columnHeaderStyle, width: 64 }}>Tools</div>
        <div style={{ ...columnHeaderStyle, width: 80 }}>Actions</div>
      </div>

      {servers.map((server) => (
        <McpServerRow
          key={server.name}
          server={server}
          onClick={() => onRowClick(server.name)}
          onReconnect={() => onReconnect(server.name)}
          onRename={(newName) => onRename(server.name, newName)}
          onDelete={() => onDelete(server.name)}
        />
      ))}
    </div>
  );
}
