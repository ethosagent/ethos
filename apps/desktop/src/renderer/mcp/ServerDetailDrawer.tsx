import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useServerUrl } from '../shell/ServerUrl';
import { Chip } from '../ui/Chip';
import { DrawerShell } from '../ui/DrawerShell';
import { SectionLabel } from '../ui/SectionLabel';
import { StatusDot } from '../ui/StatusDot';
import { BearerTokenUpdateFlow } from './components/BearerTokenUpdateFlow';
import { PerPersonalityToggles } from './components/PerPersonalityToggles';
import type { McpServerInfo } from './McpPage';

interface ServerDetailDrawerProps {
  open: boolean;
  serverName: string;
  server: McpServerInfo | null;
  onClose: () => void;
  onDeleted: () => void;
  onRenamed: (newName: string) => void;
}

interface ToolInfo {
  name: string;
  description?: string;
}

function transportChipVariant(
  transport: McpServerInfo['transport'],
): 'success' | 'info' | 'warning' | 'neutral' {
  if (transport === 'stdio') return 'neutral';
  if (transport === 'sse') return 'info';
  return 'warning';
}

function statusColor(authStatus: McpServerInfo['auth_status']): string {
  if (authStatus === 'authorized') return 'var(--success)';
  if (authStatus === 'expired' || authStatus === 'missing') return 'var(--error)';
  if (authStatus === 'pending') return 'var(--warning)';
  return 'var(--text-tertiary)';
}

function statusLabel(authStatus: McpServerInfo['auth_status']): string {
  if (authStatus === 'authorized') return 'Connected';
  if (authStatus === 'expired') return 'Expired';
  if (authStatus === 'missing') return 'Missing';
  if (authStatus === 'pending') return 'Pending';
  if (authStatus === 'none') return 'No auth';
  return 'Disconnected';
}

function authTypeLabel(server: McpServerInfo): string {
  if (server.url && server.auth_status !== 'none') return 'OAuth';
  if (server.auth_status === 'authorized' && server.transport === 'sse') return 'Bearer token';
  if (server.auth_status === 'authorized' && server.transport === 'streamable-http') {
    return 'Bearer token';
  }
  return 'None';
}

function isDisconnected(authStatus: McpServerInfo['auth_status']): boolean {
  return authStatus === 'expired' || authStatus === null;
}

export function ServerDetailDrawer({
  open,
  serverName,
  server,
  onClose,
  onDeleted,
  onRenamed,
}: ServerDetailDrawerProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(serverName);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);

  const [toolsOpen, setToolsOpen] = useState(true);
  const [authOpen, setAuthOpen] = useState(false);
  const [personalitiesOpen, setPersonalitiesOpen] = useState(false);

  const [refreshFeedback, setRefreshFeedback] = useState<string | null>(null);

  useEffect(() => {
    setDraftName(serverName);
  }, [serverName]);

  useEffect(() => {
    if (!open || !server) return;
    let cancelled = false;

    if (isDisconnected(server.auth_status)) {
      setToolsLoading(false);
      setTools([]);
      return;
    }

    (async () => {
      setToolsLoading(true);
      try {
        const res = await client.rpc.mcp.serverTools({
          personalityId: 'default',
          serverName,
        });
        if (!cancelled) setTools(res.tools as ToolInfo[]);
      } finally {
        if (!cancelled) setToolsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server, serverName, client]);

  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [editingName]);

  const commitRename = useCallback(async () => {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === serverName) {
      setDraftName(serverName);
      setEditingName(false);
      return;
    }
    await client.rpc.mcp.rename({ oldName: serverName, newName: trimmed });
    onRenamed(trimmed);
    setEditingName(false);
  }, [client, serverName, draftName, onRenamed]);

  const handleDelete = useCallback(async () => {
    if (!confirm('Delete server?')) return;
    await client.rpc.mcp.delete({ name: serverName });
    onDeleted();
  }, [client, serverName, onDeleted]);

  const handleOAuthReauth = useCallback(async () => {
    if (!server?.url) return;
    const result = (await client.rpc.mcp.start({ url: server.url })) as {
      authorizeUrl?: string;
    };
    if (result.authorizeUrl) {
      window.ethos.shell.openExternal({ url: result.authorizeUrl });
    }
  }, [client, server]);

  const handleRefreshToken = useCallback(async () => {
    try {
      await client.rpc.mcp.refreshToken({ serverName });
      setRefreshFeedback('Token refreshed ✓');
      setTimeout(() => setRefreshFeedback(null), 3000);
    } catch {
      setRefreshFeedback('Refresh failed');
      setTimeout(() => setRefreshFeedback(null), 3000);
    }
  }, [client, serverName]);

  const titleNode = editingName ? (
    <input
      ref={nameInputRef}
      value={draftName}
      onChange={(e) => setDraftName(e.target.value)}
      onBlur={() => void commitRename()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commitRename();
        if (e.key === 'Escape') {
          setDraftName(serverName);
          setEditingName(false);
        }
      }}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 14,
        fontWeight: 500,
        color: 'var(--text-primary)',
        background: 'var(--bg-overlay)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 4,
        padding: '0 6px',
        height: 24,
        outline: 'none',
        width: '100%',
      }}
    />
  ) : (
    // biome-ignore lint/a11y/useSemanticElements: collapsible section header
    <span
      role="button"
      tabIndex={0}
      onClick={() => setEditingName(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setEditingName(true);
      }}
      style={{ cursor: 'text' }}
    >
      {serverName}
    </span>
  );

  const headerRightNode = server ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 4 }}>
      <Chip label={server.transport} variant={transportChipVariant(server.transport)} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <StatusDot color={statusColor(server.auth_status)} />
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          {statusLabel(server.auth_status)}
        </span>
      </div>
    </div>
  ) : null;

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer',
    userSelect: 'none',
    padding: '8px 0',
  };

  const authType = server ? authTypeLabel(server) : 'None';
  const isOAuth = authType === 'OAuth';
  const isBearer = authType === 'Bearer token';

  const footerNode = (
    <div style={{ display: 'flex', width: '100%' }}>
      <button
        type="button"
        onClick={() => void handleDelete()}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--error)',
          fontSize: 14,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        Delete server
      </button>
    </div>
  );

  return (
    <DrawerShell
      open={open}
      title={titleNode}
      headerRight={headerRightNode}
      onClose={onClose}
      footer={footerNode}
    >
      <div>
        {/* biome-ignore lint/a11y/useSemanticElements: collapsible section header */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setToolsOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setToolsOpen((v) => !v);
          }}
          style={sectionHeaderStyle}
        >
          <SectionLabel>TOOLS ({toolsLoading ? '...' : tools.length})</SectionLabel>
        </div>
        {toolsOpen && (
          <div>
            {toolsLoading && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '4px 0' }}>
                Loading tools...
              </div>
            )}
            {!toolsLoading && server && isDisconnected(server.auth_status) && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '4px 0' }}>
                Connect to see available tools.
              </div>
            )}
            {!toolsLoading &&
              !isDisconnected(server?.auth_status ?? null) &&
              tools.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '4px 0' }}>
                  No tools exposed.
                </div>
              )}
            {!toolsLoading &&
              tools.map((tool) => (
                <div
                  key={tool.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    height: 32,
                    borderBottom: '1px solid var(--border-subtle)',
                    gap: 8,
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: 'var(--text-primary)',
                      flexShrink: 0,
                    }}
                  >
                    {tool.name}
                  </span>
                  {tool.description && (
                    <span
                      style={{
                        fontSize: 12,
                        color: 'var(--text-secondary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {tool.description}
                    </span>
                  )}
                </div>
              ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        {/* biome-ignore lint/a11y/useSemanticElements: collapsible section header */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setAuthOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setAuthOpen((v) => !v);
          }}
          style={sectionHeaderStyle}
        >
          <SectionLabel>AUTH</SectionLabel>
        </div>
        {authOpen && (
          <div style={{ padding: '4px 0' }}>
            <div
              style={{
                fontSize: 13,
                color: 'var(--text-secondary)',
                marginBottom: 8,
              }}
            >
              {authType}
            </div>

            {isBearer && <BearerTokenUpdateFlow serverName={serverName} />}

            {isOAuth && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => void handleOAuthReauth()}
                  style={{
                    height: 28,
                    padding: '0 10px',
                    borderRadius: 4,
                    border: '1px solid var(--border-subtle)',
                    background: 'none',
                    color: 'var(--warning)',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Re-authenticate
                </button>
                <button
                  type="button"
                  onClick={() => void handleRefreshToken()}
                  style={{
                    height: 28,
                    padding: '0 10px',
                    borderRadius: 4,
                    border: '1px solid var(--border-subtle)',
                    background: 'none',
                    color: 'var(--text-primary)',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Refresh token
                </button>
                {refreshFeedback && (
                  <span
                    style={{
                      fontSize: 13,
                      color: refreshFeedback.includes('✓') ? 'var(--success)' : 'var(--error)',
                    }}
                  >
                    {refreshFeedback}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        {/* biome-ignore lint/a11y/useSemanticElements: collapsible section header */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setPersonalitiesOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setPersonalitiesOpen((v) => !v);
          }}
          style={sectionHeaderStyle}
        >
          <SectionLabel>ATTACHED PERSONALITIES</SectionLabel>
        </div>
        {personalitiesOpen && <PerPersonalityToggles serverName={serverName} />}
      </div>
    </DrawerShell>
  );
}
