import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../shell/ServerUrl';
import { ChannelsTab } from './ChannelsTab';
import { McpServersTab } from './McpServersTab';
import { ProvidersTab } from './ProvidersTab';

export interface Channel {
  id: string;
  platform: string;
  status: 'connected' | 'disconnected' | 'error';
  webhookUrl?: string;
}

export interface Provider {
  id: string;
  name: string;
  hasKey: boolean;
  healthy?: boolean;
  latencyMs?: number;
}

export interface McpServer {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount?: number;
}

type TabId = 'channels' | 'providers' | 'mcp';

const tabs: { id: TabId; label: string }[] = [
  { id: 'channels', label: 'Channels' },
  { id: 'providers', label: 'API Keys' },
  { id: 'mcp', label: 'MCP Servers' },
];

export function AdminPage() {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [activeTab, setActiveTab] = useState<TabId>('channels');
  const [status, setStatus] = useState<{
    channels: Channel[];
    providers: Provider[];
    mcpServers: McpServer[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adminEnabled, setAdminEnabled] = useState<boolean | null>(null);
  const [disabledForbidden, setDisabledForbidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await client.rpc.admin.getStatus();
      setStatus(s);
      setError(null);
      setDisabledForbidden(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toUpperCase().includes('FORBIDDEN')) {
        setDisabledForbidden(true);
      } else {
        setError(`Failed to load admin status: ${msg}`);
      }
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const cfg = await client.rpc.config.get();
        if (!cancelled) setAdminEnabled(cfg.adminEnabled);
      } catch {
        /* best-effort, leave adminEnabled null */
      }
      if (!cancelled) await load();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, load]);

  if (adminEnabled === false || disabledForbidden) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--text-secondary)',
          fontSize: 14,
          padding: 24,
          textAlign: 'center',
        }}
      >
        Admin is disabled. Enable admin.enabled in config.
      </div>
    );
  }

  if (loading && !status) {
    return <div style={{ padding: 24, color: 'var(--text-tertiary)', fontSize: 14 }}>Loading…</div>;
  }

  if (error) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--error)',
          fontSize: 14,
          padding: 24,
          textAlign: 'center',
        }}
      >
        {error}
      </div>
    );
  }

  const channels = status?.channels ?? [];
  const providers = status?.providers ?? [];
  const mcpServers = status?.mcpServers ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 40,
          padding: '0 16px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              type="button"
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'none',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                cursor: 'pointer',
                padding: '8px 12px',
                fontSize: 13,
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: isActive ? 500 : 400,
                transition: `color var(--motion-fast) var(--ease)`,
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeTab === 'channels' && (
          <ChannelsTab client={client} channels={channels} onReload={load} />
        )}
        {activeTab === 'providers' && (
          <ProvidersTab client={client} providers={providers} onReload={load} />
        )}
        {activeTab === 'mcp' && (
          <McpServersTab client={client} mcpServers={mcpServers} onReload={load} />
        )}
      </div>
    </div>
  );
}
