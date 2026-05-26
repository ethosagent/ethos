import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../state/AppContext';
import { AddServerDrawer } from './AddServerDrawer';
import { McpServerTable } from './McpServerTable';
import { ServerDetailDrawer } from './ServerDetailDrawer';

export interface McpServerInfo {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command: string | null;
  url: string | null;
  auth_status: 'none' | 'authorized' | 'expired' | 'missing' | 'pending' | null;
  created_via: 'cli' | 'ui' | null;
  mcpResultLimitChars: number | null;
  deprecated: boolean | null;
}

type DrawerMode = 'none' | 'add' | 'detail';

export function McpPage() {
  const { state } = useAppState();
  const baseUrl = `http://localhost:${state.port}`;
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [drawerMode, setDrawerMode] = useState<DrawerMode>('none');
  const [selectedServer, setSelectedServer] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await client.rpc.mcp.list({});
    setServers(result.servers as McpServerInfo[]);
  }, [client]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleOpenDetail = useCallback((name: string) => {
    setSelectedServer(name);
    setDrawerMode('detail');
  }, []);

  const handleClose = useCallback(() => {
    setDrawerMode('none');
    setSelectedServer(null);
  }, []);

  const handleServerAdded = useCallback(() => {
    reload();
    setDrawerMode('none');
  }, [reload]);

  const handleServerDeleted = useCallback(() => {
    reload();
    setDrawerMode('none');
    setSelectedServer(null);
  }, [reload]);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: '0 24px',
      }}
    >
      <div
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          paddingTop: 8,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          MCP Servers
        </h3>
        <button
          type="button"
          onClick={() => setDrawerMode('add')}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 4,
            border: '1px solid var(--border-subtle)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Add server
        </button>
      </div>

      <McpServerTable
        servers={servers}
        onRowClick={handleOpenDetail}
        onReconnect={(name) => {
          void client.rpc.mcp.reconnect({ name }).then(reload);
        }}
        onRename={(oldName, newName) => {
          void client.rpc.mcp.rename({ oldName, newName }).then(reload);
        }}
        onDelete={(name) => {
          void client.rpc.mcp.delete({ name }).then(reload);
        }}
        onAddServer={() => setDrawerMode('add')}
      />

      {drawerMode === 'add' && (
        <AddServerDrawer onClose={handleClose} onServerAdded={handleServerAdded} />
      )}

      {drawerMode === 'detail' && selectedServer && (
        <ServerDetailDrawer
          open={true}
          serverName={selectedServer}
          server={servers.find((s) => s.name === selectedServer) ?? null}
          onClose={handleClose}
          onDeleted={handleServerDeleted}
          onRenamed={(newName) => {
            setSelectedServer(newName);
            reload();
          }}
          port={state.port}
        />
      )}
    </div>
  );
}
