import type { McpPolicy } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Result, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ConnectMcpModal } from '../components/mcp/ConnectMcpModal';
import { PersonalityMark } from '../components/ui/PersonalityMark';
import { rpc } from '../rpc';
import {
  EditModal,
  initialSelectionFor,
  ServerToolChecklist,
  type ServerToolState,
} from './Personalities';

// ---------------------------------------------------------------------------
// MCP Section — shows per-server connection state, auth actions, tool checklists
// ---------------------------------------------------------------------------

const OAUTH_POPUP_WIDTH = 520;
const OAUTH_POPUP_HEIGHT = 720;

function McpSection({
  personalityId,
  mcpPolicy,
}: {
  personalityId: string;
  mcpPolicy: McpPolicy | null;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [toolState, setToolState] = useState<Record<string, ServerToolState>>({});
  const [dirty, setDirty] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  // OAuth flow state
  const [oauthServer, setOauthServer] = useState<string | null>(null);
  const [oauthState, setOauthState] = useState('');
  const popupRef = useRef<Window | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['mcp', 'personalityServers', personalityId],
    queryFn: () => rpc.mcp.personalityServers({ personalityId }),
  });

  const saveMut = useMutation({
    mutationFn: () => {
      const mcpServers = servers.map((s) => s.name);
      const mcpTools: Record<string, string[]> = {};
      for (const server of mcpServers) {
        const st = toolState[server];
        if (!st || st.tools == null) continue;
        if (st.selected.size < st.tools.length) {
          mcpTools[server] = st.tools.filter((t) => st.selected.has(t));
        }
      }
      return rpc.personalities.update({
        id: personalityId,
        mcp_servers: mcpServers,
        mcp_tools: mcpTools,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', personalityId] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', personalityId] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      setDirty(false);
      notification.success({ message: 'Tool selection saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const reconnectMut = useMutation({
    mutationFn: (input: { name: string }) => rpc.mcp.reconnect(input),
    onSuccess: (result, variables) => {
      if (!result.ok) {
        notification.error({
          message: 'Authentication failed',
          description: 'detail' in result ? result.detail : result.code,
        });
        return;
      }
      setOauthServer(variables.name);
      setOauthState(result.state);
      const popup = window.open(
        result.authorizeUrl,
        '_blank',
        `width=${OAUTH_POPUP_WIDTH},height=${OAUTH_POPUP_HEIGHT}`,
      );
      if (!popup || popup.closed) {
        sessionStorage.setItem('ethos:mcp_oauth_return', `/personalities/${personalityId}`);
        window.location.href = result.authorizeUrl;
        return;
      }
      popupRef.current = popup;
      startPolling();
    },
    onError: (err) =>
      notification.error({
        message: 'Authentication failed',
        description: err instanceof Error ? err.message : String(err),
      }),
  });

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(async () => {
      try {
        const result = await rpc.mcp.status();
        if (result.status === 'connected') {
          stopPolling();
          setOauthServer(null);
          setOauthState('');
          qc.invalidateQueries({ queryKey: ['mcp', 'personalityServers', personalityId] });
          notification.success({ message: 'Authentication successful', placement: 'topRight' });
        } else if (result.status === 'error') {
          stopPolling();
          setOauthServer(null);
          notification.error({ message: 'Authentication failed', description: result.error });
        } else if (result.status === 'expired') {
          stopPolling();
          setOauthServer(null);
          notification.error({ message: 'Authorization session expired' });
        }
      } catch {
        // Keep polling
      }
    }, 2000);
  }, [stopPolling, personalityId, qc, notification]);

  // Listen for postMessage from OAuth popup
  useEffect(() => {
    if (!oauthServer) return;

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const msg = event.data as Record<string, unknown> | null;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ethos:mcp_oauth_success' && msg.state === oauthState) {
        stopPolling();
        setOauthServer(null);
        setOauthState('');
        qc.invalidateQueries({ queryKey: ['mcp', 'personalityServers', personalityId] });
        notification.success({ message: 'Authentication successful', placement: 'topRight' });
      } else if (msg.type === 'ethos:mcp_oauth_error' && msg.state === oauthState) {
        stopPolling();
        setOauthServer(null);
        setOauthState('');
        const detail = typeof msg.detail === 'string' ? msg.detail : undefined;
        const code = typeof msg.code === 'string' ? msg.code : undefined;
        notification.error({
          message: 'Authentication failed',
          description: detail ?? code ?? 'OAuth failed',
        });
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [oauthServer, oauthState, stopPolling, personalityId, qc, notification]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const handleDiscovered = (serverName: string, discovered: string[]) => {
    setToolState((prev) => {
      if (prev[serverName]?.tools != null) return prev;
      const policyTools = initialSelectionFor(serverName, mcpPolicy);
      const selected = new Set(policyTools ?? discovered);
      return { ...prev, [serverName]: { tools: discovered, selected } };
    });
  };

  const handleToggle = (serverName: string, toolName: string) => {
    setToolState((prev) => {
      const st = prev[serverName];
      if (!st) return prev;
      const selected = new Set(st.selected);
      if (selected.has(toolName)) selected.delete(toolName);
      else selected.add(toolName);
      return { ...prev, [serverName]: { ...st, selected } };
    });
    setDirty(true);
  };

  const handleAuthenticate = (serverName: string) => {
    reconnectMut.mutate({ name: serverName });
  };

  const servers = data?.servers ?? [];

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div style={{ marginBottom: 32 }}>
        <Typography.Title level={5} style={{ marginBottom: 12 }}>
          MCP Servers
        </Typography.Title>
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          No MCP servers attached to this personality.
        </Typography.Text>
        <Button onClick={() => setConnectOpen(true)}>Connect a server</Button>
        <ConnectMcpModal
          open={connectOpen}
          personalityId={personalityId}
          existingServers={[]}
          onClose={() => setConnectOpen(false)}
          onConnected={() => setConnectOpen(false)}
        />
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          MCP Servers
        </Typography.Title>
        <Button onClick={() => setConnectOpen(true)}>Connect server</Button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {servers.map((server) => (
          <div
            key={server.name}
            style={{ borderBottom: '1px solid var(--border-subtle, #2A2A2A)', paddingBottom: 12 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Typography.Text strong>{server.name}</Typography.Text>
              {server.transport ? (
                <Tag bordered={false} style={{ fontSize: 11 }}>
                  {server.transport}
                </Tag>
              ) : null}
              {server.url ? (
                <Typography.Text
                  type="secondary"
                  style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
                >
                  {server.url}
                </Typography.Text>
              ) : null}
              {server.auth_status === 'authorized' ? (
                <Tag color="green" bordered={false} style={{ fontSize: 11 }}>
                  Connected
                </Tag>
              ) : server.auth_status === 'missing' ? (
                <Tag color="orange" bordered={false} style={{ fontSize: 11 }}>
                  Pending authentication
                </Tag>
              ) : (
                <Tag color="red" bordered={false} style={{ fontSize: 11 }}>
                  Token expired
                </Tag>
              )}
            </div>

            {server.auth_status === 'missing' ? (
              <div style={{ paddingLeft: 0, paddingTop: 4 }}>
                <Button
                  size="small"
                  onClick={() => handleAuthenticate(server.name)}
                  loading={reconnectMut.isPending && oauthServer === server.name}
                  disabled={!server.url}
                >
                  Authenticate
                </Button>
              </div>
            ) : null}

            {server.auth_status === 'expired' ? (
              <div style={{ paddingLeft: 0, paddingTop: 4, marginBottom: 4 }}>
                <Button
                  size="small"
                  onClick={() => handleAuthenticate(server.name)}
                  loading={reconnectMut.isPending && oauthServer === server.name}
                  disabled={!server.url}
                >
                  Re-authenticate
                </Button>
              </div>
            ) : null}

            {server.auth_status === 'authorized' || server.auth_status === 'expired' ? (
              <ServerToolChecklist
                personalityId={personalityId}
                serverName={server.name}
                state={toolState[server.name]}
                onDiscovered={(tools) => handleDiscovered(server.name, tools)}
                onToggle={(toolName) => handleToggle(server.name, toolName)}
              />
            ) : null}
          </div>
        ))}
      </div>

      {dirty ? (
        <Button
          type="primary"
          loading={saveMut.isPending}
          onClick={() => saveMut.mutate()}
          style={{ marginTop: 12 }}
        >
          Save tool selection
        </Button>
      ) : null}

      <ConnectMcpModal
        open={connectOpen}
        personalityId={personalityId}
        existingServers={servers.map((s) => s.name)}
        onClose={() => setConnectOpen(false)}
        onConnected={() => setConnectOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// PersonalityDetail page
// ---------------------------------------------------------------------------

export function PersonalityDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editModalOpen, setEditModalOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['personalities', 'get', id],
    queryFn: () => rpc.personalities.get({ id }),
    enabled: id.length > 0,
  });

  if (!id) {
    return <Result status="404" title="Personality not found" />;
  }
  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (error || !data) {
    return <Result status="error" title="Failed to load personality" />;
  }

  const { personality } = data;
  const model = personality.model;
  const modelDisplay =
    typeof model === 'string'
      ? model
      : model
        ? (model.default ?? model.trivial ?? model.deep ?? null)
        : null;

  return (
    <div style={{ padding: 24, maxWidth: 960 }}>
      <Button
        type="link"
        onClick={() => navigate('/personalities')}
        style={{ paddingLeft: 0, marginBottom: 16 }}
      >
        &larr; Personalities
      </Button>

      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <PersonalityMark personalityId={personality.id} size={48} />
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              {personality.name}
            </Typography.Title>
            <Typography.Text
              type="secondary"
              style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
            >
              {personality.id}
            </Typography.Text>
          </div>
        </div>

        {personality.description ? (
          <Typography.Paragraph type="secondary">{personality.description}</Typography.Paragraph>
        ) : null}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '8px 24px',
            fontSize: 14,
          }}
        >
          {modelDisplay ? (
            <>
              <Typography.Text type="secondary">Model</Typography.Text>
              <Typography.Text code>{modelDisplay}</Typography.Text>
            </>
          ) : null}
          {personality.fs_reach !== undefined && personality.fs_reach !== null ? (
            <>
              <Typography.Text type="secondary">FS reach</Typography.Text>
              <Typography.Text>
                {[
                  ...(personality.fs_reach.read ?? []).map((p: string) => `R ${p}`),
                  ...(personality.fs_reach.write ?? []).map((p: string) => `W ${p}`),
                ].join(', ') || 'none'}
              </Typography.Text>
            </>
          ) : null}
        </div>

        <div style={{ marginTop: 16 }}>
          <Button onClick={() => setEditModalOpen(true)}>Edit personality</Button>
        </div>
      </div>

      {!personality.builtin && <McpSection personalityId={id} mcpPolicy={data.mcpPolicy} />}

      {editModalOpen ? (
        <EditModal
          id={id}
          onClose={() => {
            setEditModalOpen(false);
            qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
          }}
        />
      ) : null}
    </div>
  );
}
