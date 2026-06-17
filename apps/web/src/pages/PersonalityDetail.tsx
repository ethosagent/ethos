import type { McpPolicy, Personality } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Input,
  Modal,
  Result,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LivingSoulSection } from '../components/LivingSoulSection';
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

  // Issue 2: per-server enabled state, derived from mcpPolicy
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>({});

  // OAuth flow state
  const [oauthServer, setOauthServer] = useState<string | null>(null);
  const [oauthState, setOauthState] = useState('');
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [bearerTokenServer, setBearerTokenServer] = useState<string | null>(null);
  const [bearerTokenInput, setBearerTokenInput] = useState('');
  const [testResult, setTestResult] = useState<{
    serverName: string;
    ok: boolean;
    tools: { name: string; description?: string }[];
    /** Raw error message from the thrown exception or the API. */
    error?: string;
    /** Classified failure kind — drives the guidance copy in the modal. */
    errorKind?:
      | 'auth_missing'
      | 'auth_rejected'
      | 'no_tools'
      | 'timeout'
      | 'connection_refused'
      | 'unknown';
  } | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingStartRef = useRef<number>(0);

  const { data, isLoading } = useQuery({
    queryKey: ['mcp', 'personalityServers', personalityId],
    queryFn: () => rpc.mcp.personalityServers({ personalityId }),
  });

  // Issue 2: initialize enabledMap from policy on first load
  useEffect(() => {
    if (!data) return;
    const init: Record<string, boolean> = {};
    for (const s of data.servers) {
      const policy = mcpPolicy?.servers?.[s.name];
      // Default to enabled unless explicitly disabled in mcp.yaml
      init[s.name] = policy?.enabled !== false;
    }
    setEnabledMap(init);
  }, [data, mcpPolicy]);

  const saveMut = useMutation({
    mutationFn: () => {
      // Only include enabled servers
      const mcpServers = servers.filter((s) => enabledMap[s.name] !== false).map((s) => s.name);
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
    mutationFn: (input: { name: string; personalityId?: string }) => rpc.mcp.reconnect(input),
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

  const setTokenMut = useMutation({
    mutationFn: ({ server, token }: { server: string; token: string }) =>
      rpc.personalities.mcpSetToken({ personalityId, server, token }),
    onSuccess: () => {
      setBearerTokenServer(null);
      setBearerTokenInput('');
      qc.invalidateQueries({ queryKey: ['mcp', 'personalityServers', personalityId] });
      notification.success({ message: 'Token saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to save token',
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
    pollingStartRef.current = Date.now();
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
          if (Date.now() - pollingStartRef.current >= 5 * 60 * 1000) {
            stopPolling();
            setOauthServer(null);
            setOauthState('');
            notification.error({ message: 'Authorization session expired' });
          }
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
      try {
        const h = new URL(event.origin).hostname;
        if (h !== 'localhost' && h !== '127.0.0.1') return;
      } catch {
        return;
      }
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

  const handleTest = async (serverName: string) => {
    setTestingServer(serverName);
    try {
      const result = await rpc.mcp.serverTools({ personalityId, serverName });
      if (result.available && result.tools.length > 0) {
        setTestResult({ serverName, ok: true, tools: result.tools });
      } else {
        const server = data?.servers.find((s) => s.name === serverName);
        const authMissing = server?.auth_status === 'missing';
        setTestResult({
          serverName,
          ok: false,
          tools: [],
          error: authMissing
            ? 'No authentication token is configured for this server.'
            : 'Server connected but returned no tools.',
          errorKind: authMissing ? 'auth_missing' : 'no_tools',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      const errorKind =
        lower.includes('timeout') || lower.includes('timed out')
          ? 'timeout'
          : lower.includes('401') || lower.includes('unauthorized')
            ? 'auth_rejected'
            : lower.includes('403') || lower.includes('forbidden')
              ? 'auth_rejected'
              : lower.includes('econnrefused') || lower.includes('connection refused')
                ? 'connection_refused'
                : 'unknown';
      setTestResult({ serverName, ok: false, tools: [], error: msg, errorKind });
    } finally {
      setTestingServer(null);
    }
  };

  const handleAuthenticate = (serverName: string) => {
    reconnectMut.mutate({ name: serverName, personalityId });
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
            style={{
              borderBottom: '1px solid var(--border-subtle, #2A2A2A)',
              paddingBottom: 12,
              opacity: enabledMap[server.name] === false ? 0.5 : 1,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              {/* Issue 2: enable/disable toggle */}
              <Tooltip
                title={enabledMap[server.name] === false ? 'Enable server' : 'Disable server'}
              >
                <Switch
                  size="small"
                  checked={enabledMap[server.name] !== false}
                  onChange={(checked) => {
                    setEnabledMap((prev) => ({ ...prev, [server.name]: checked }));
                    setDirty(true);
                  }}
                />
              </Tooltip>
              <Typography.Text strong>{server.name}</Typography.Text>
              {server.transport ? (
                <Tag bordered={false} style={{ fontSize: 11 }}>
                  {server.transport}
                </Tag>
              ) : null}
              {/* Issue 7: SSE deprecation tag */}
              {server.transport === 'sse' ? (
                <Tag color="warning" bordered={false} style={{ fontSize: 11 }}>
                  deprecated
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

            {server.auth_status === 'missing' && server.auth_type === 'bearer' ? (
              <div style={{ paddingLeft: 0, paddingTop: 4 }}>
                <Button
                  size="small"
                  onClick={() => {
                    setBearerTokenInput('');
                    setBearerTokenServer(server.name);
                  }}
                >
                  Set token
                </Button>
              </div>
            ) : server.auth_status === 'missing' ? (
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

            {server.auth_status === 'authorized' ? (
              <div
                style={{ paddingLeft: 0, paddingTop: 4, marginBottom: 4, display: 'flex', gap: 8 }}
              >
                <Button
                  size="small"
                  loading={testingServer === server.name}
                  onClick={() => handleTest(server.name)}
                >
                  Test connection
                </Button>
                {server.auth_type === 'bearer' ? (
                  <Button
                    size="small"
                    onClick={() => {
                      setBearerTokenInput('');
                      setBearerTokenServer(server.name);
                    }}
                  >
                    Update token
                  </Button>
                ) : null}
                {server.auth_type === 'none' && server.transport !== 'stdio' ? (
                  <Button
                    size="small"
                    onClick={() => {
                      setBearerTokenInput('');
                      setBearerTokenServer(server.name);
                    }}
                  >
                    Set bearer token
                  </Button>
                ) : null}
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

      <Modal
        open={bearerTokenServer !== null}
        title={`Bearer Token — ${bearerTokenServer ?? ''}`}
        onCancel={() => setBearerTokenServer(null)}
        onOk={() => {
          if (bearerTokenServer && bearerTokenInput.trim()) {
            setTokenMut.mutate({ server: bearerTokenServer, token: bearerTokenInput.trim() });
          }
        }}
        okText="Save token"
        confirmLoading={setTokenMut.isPending}
        okButtonProps={{ disabled: !bearerTokenInput.trim() }}
        width={460}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          Paste the bearer token for this server. It is stored securely and sent as an{' '}
          <Typography.Text code style={{ fontSize: 11 }}>
            Authorization: Bearer …
          </Typography.Text>{' '}
          header on every request.
        </Typography.Paragraph>
        <Input.Password
          value={bearerTokenInput}
          onChange={(e) => setBearerTokenInput(e.target.value)}
          placeholder="Paste bearer token"
          autoFocus
        />
      </Modal>
      <Modal
        open={testResult !== null}
        onCancel={() => setTestResult(null)}
        footer={
          <Button type="primary" onClick={() => setTestResult(null)}>
            Close
          </Button>
        }
        title={`Test Connection — ${testResult?.serverName ?? ''}`}
        width={520}
      >
        {testResult?.ok ? (
          <div>
            <Result
              status="success"
              title="Connected"
              subTitle={`${testResult.tools.length} tool${testResult.tools.length === 1 ? '' : 's'} available`}
              style={{ paddingBlock: 16 }}
            />
            <div
              style={{
                maxHeight: 280,
                overflowY: 'auto',
                border: '1px solid var(--color-border, #f0f0f0)',
                borderRadius: 6,
                padding: '8px 12px',
              }}
            >
              {testResult.tools.map((t) => (
                <div key={t.name} style={{ marginBottom: 6 }}>
                  <Typography.Text code style={{ fontSize: 11 }}>
                    {t.name}
                  </Typography.Text>
                  {t.description ? (
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 11, marginLeft: 8, display: 'inline' }}
                    >
                      {t.description}
                    </Typography.Text>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Result
            status="error"
            title="Connection Failed"
            subTitle={(() => {
              switch (testResult?.errorKind) {
                case 'auth_missing':
                  return 'No authentication token configured.';
                case 'auth_rejected':
                  return 'Server rejected the credentials.';
                case 'no_tools':
                  return 'Server connected but returned no tools.';
                case 'timeout':
                  return 'Server did not respond within 10 seconds.';
                case 'connection_refused':
                  return 'Connection refused — server may be down.';
                default:
                  return 'An unexpected error occurred.';
              }
            })()}
            extra={
              <div style={{ textAlign: 'left', maxWidth: 420, margin: '0 auto' }}>
                {testResult?.error ? (
                  <Typography.Text
                    code
                    style={{
                      display: 'block',
                      fontSize: 11,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      marginBottom: 12,
                    }}
                  >
                    {testResult.error}
                  </Typography.Text>
                ) : null}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {testResult?.errorKind === 'auth_missing' &&
                    'Set a bearer token via Edit Personality, or use Authenticate to complete OAuth.'}
                  {testResult?.errorKind === 'auth_rejected' &&
                    'The token may be expired or have insufficient permissions. Update the bearer token or re-authenticate.'}
                  {testResult?.errorKind === 'no_tools' &&
                    'The token might lack the required permissions, or this account has no tools on this server.'}
                  {testResult?.errorKind === 'timeout' &&
                    'Check that the server URL is correct and the server is reachable from this machine.'}
                  {testResult?.errorKind === 'connection_refused' &&
                    'Verify the server URL and port. The server may not be running or may be blocking connections.'}
                  {testResult?.errorKind === 'unknown' &&
                    'Check the server URL, authentication settings, and network connectivity.'}
                </Typography.Text>
              </div>
            }
            style={{ paddingBlock: 16 }}
          />
        )}
      </Modal>
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
// Overview — labeled read-only view of the personality config. Each row is
// annotated with what it's for so a reader understands the personality without
// opening Edit. Rows with no data are omitted.
// ---------------------------------------------------------------------------

function OverviewRow({
  label,
  gloss,
  children,
}: {
  label: string;
  gloss?: string;
  children: ReactNode;
}) {
  return (
    <>
      <div>
        <Typography.Text type="secondary">{label}</Typography.Text>
        {gloss ? (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
            {gloss}
          </Typography.Paragraph>
        ) : null}
      </div>
      <div>{children}</div>
    </>
  );
}

function OverviewSection({ personality }: { personality: Personality }) {
  const model = personality.model;
  const tiered = model && typeof model !== 'string' ? model : null;
  const flatModel = typeof model === 'string' ? model : null;

  const fsRead = personality.fs_reach?.read ?? [];
  const fsWrite = personality.fs_reach?.write ?? [];
  const hasFsReach = fsRead.length > 0 || fsWrite.length > 0;

  const skillEvo = personality.skill_evolution;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(160px, auto) 1fr',
        gap: '16px 24px',
        fontSize: 14,
        alignItems: 'start',
      }}
    >
      <OverviewRow label="Provider" gloss="LLM backend that runs this personality">
        <Typography.Text code>{personality.provider ?? 'engine default'}</Typography.Text>
      </OverviewRow>

      {flatModel ? (
        <OverviewRow label="Model" gloss="Model used for every turn">
          <Typography.Text code>{flatModel}</Typography.Text>
        </OverviewRow>
      ) : null}

      {tiered ? (
        <OverviewRow label="Model routing" gloss="Per-difficulty model selection">
          <div style={{ display: 'grid', gap: 4 }}>
            {tiered.trivial ? (
              <div>
                <Typography.Text code>{tiered.trivial}</Typography.Text>{' '}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Trivial — simple, low-effort turns
                </Typography.Text>
              </div>
            ) : null}
            {tiered.default ? (
              <div>
                <Typography.Text code>{tiered.default}</Typography.Text>{' '}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Default — the everyday turn
                </Typography.Text>
              </div>
            ) : null}
            {tiered.deep ? (
              <div>
                <Typography.Text code>{tiered.deep}</Typography.Text>{' '}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Deep — hard, high-reasoning turns
                </Typography.Text>
              </div>
            ) : null}
          </div>
        </OverviewRow>
      ) : null}

      <OverviewRow
        label="Memory scope"
        gloss="Which memory store this personality reads and writes"
      >
        <Typography.Text code>personality:{personality.id}</Typography.Text>
      </OverviewRow>

      {personality.capabilities && personality.capabilities.length > 0 ? (
        <OverviewRow label="Capabilities" gloss="Capability tokens declared by this personality">
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {personality.capabilities.map((c) => (
              <Tag key={c} bordered={false}>
                {c}
              </Tag>
            ))}
          </span>
        </OverviewRow>
      ) : null}

      {personality.dreaming ? (
        <OverviewRow label="Dreaming" gloss="Idle-time memory consolidation">
          <Typography.Text>{personality.dreaming.enable ? 'On' : 'Off'}</Typography.Text>
        </OverviewRow>
      ) : null}

      {personality.evolution_approval_mode ? (
        <OverviewRow
          label="Evolution approval"
          gloss={
            personality.evolution_approval_mode === 'auto'
              ? 'Learned changes apply automatically'
              : 'Learned changes wait for your approval'
          }
        >
          <Typography.Text>
            {personality.evolution_approval_mode === 'auto' ? 'Automatic' : 'Requires approval'}
          </Typography.Text>
        </OverviewRow>
      ) : null}

      {skillEvo ? (
        <OverviewRow
          label="Skill evolution"
          gloss="When the agent proposes new skills from repeated tool patterns"
        >
          <div style={{ display: 'grid', gap: 2 }}>
            <Typography.Text>{skillEvo.enabled ? 'Enabled' : 'Disabled'}</Typography.Text>
            {skillEvo.min_tool_calls !== undefined ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Min tool calls: {skillEvo.min_tool_calls}
              </Typography.Text>
            ) : null}
            {skillEvo.cooldown_minutes !== undefined ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Cooldown: {skillEvo.cooldown_minutes} min
              </Typography.Text>
            ) : null}
          </div>
        </OverviewRow>
      ) : null}

      {personality.plugins && personality.plugins.length > 0 ? (
        <OverviewRow label="Plugins" gloss="Attached plugin contract surfaces">
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {personality.plugins.map((p) => (
              <Tag key={p} bordered={false}>
                {p}
              </Tag>
            ))}
          </span>
        </OverviewRow>
      ) : null}

      {hasFsReach ? (
        <OverviewRow label="Filesystem reach" gloss="Paths this personality may read or write">
          <div style={{ display: 'grid', gap: 2 }}>
            {fsRead.length > 0 ? (
              <Typography.Text style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>
                Read: {fsRead.join(', ')}
              </Typography.Text>
            ) : null}
            {fsWrite.length > 0 ? (
              <Typography.Text style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>
                Write: {fsWrite.join(', ')}
              </Typography.Text>
            ) : null}
          </div>
        </OverviewRow>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tools — the personality's allowed tools, grouped by toolset, annotated with
// descriptions from the tool catalog (`tools.catalog`). Tools in the allowlist
// that the catalog doesn't know about render name-only.
// ---------------------------------------------------------------------------

function ToolsSection({ toolset }: { toolset: string[] }) {
  const { data, isLoading } = useQuery({
    queryKey: ['tools', 'catalog'],
    queryFn: () => rpc.tools.catalog({}),
  });

  if (toolset.length === 0) {
    return (
      <Typography.Text type="secondary">
        This personality has no tools in its toolset.
      </Typography.Text>
    );
  }

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  // Build name -> { group, description } from the catalog.
  const meta = new Map<string, { group: string; description?: string }>();
  for (const g of data?.groups ?? []) {
    for (const t of g.tools) {
      meta.set(t.name, {
        group: g.group,
        ...(t.description ? { description: t.description } : {}),
      });
    }
  }

  // Group the personality's allowed tools by their catalog group.
  const grouped = new Map<string, { name: string; description?: string }[]>();
  const ungrouped = 'Other';
  for (const name of toolset) {
    const m = meta.get(name);
    const group = m?.group ?? ungrouped;
    let arr = grouped.get(group);
    if (!arr) {
      arr = [];
      grouped.set(group, arr);
    }
    arr.push({ name, ...(m?.description ? { description: m.description } : {}) });
  }

  const hasUnknownTools = toolset.some((name) => !meta.get(name)?.description);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {!data || data.groups.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Tool descriptions appear after the agent's first session loads the tool registry.
        </Typography.Text>
      ) : hasUnknownTools ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Some tools have no catalog description yet — they show name-only.
        </Typography.Text>
      ) : null}

      {[...grouped.entries()].map(([group, tools]) => (
        <div key={group}>
          <Typography.Text
            type="secondary"
            style={{
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontSize: 11,
              fontWeight: 500,
            }}
          >
            {group}
          </Typography.Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {tools.map((t) => (
              <div key={t.name}>
                <Typography.Text code style={{ fontSize: 13 }}>
                  {t.name}
                </Typography.Text>
                {t.description ? (
                  <Typography.Paragraph
                    type="secondary"
                    style={{ fontSize: 13, margin: '2px 0 0' }}
                  >
                    {t.description}
                  </Typography.Paragraph>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}
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

  const tabItems = [
    {
      key: 'overview',
      label: 'Overview',
      children: <OverviewSection personality={personality} />,
    },
    {
      key: 'tools',
      label: 'Tools',
      children: <ToolsSection toolset={personality.toolset ?? []} />,
    },
  ];
  if (!personality.builtin) {
    tabItems.push(
      {
        key: 'soul',
        label: 'Living Soul',
        children: <LivingSoulSection personalityId={id} />,
      },
      {
        key: 'mcp',
        label: 'MCP',
        children: <McpSection personalityId={id} mcpPolicy={data.mcpPolicy} />,
      },
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 960 }}>
      <Button
        type="link"
        onClick={() => navigate('/personalities')}
        style={{ paddingLeft: 0, marginBottom: 16 }}
      >
        &larr; Personalities
      </Button>

      <div style={{ marginBottom: 24 }}>
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
          <Button style={{ marginLeft: 'auto' }} onClick={() => setEditModalOpen(true)}>
            Edit personality
          </Button>
        </div>

        {personality.description ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {personality.description}
          </Typography.Paragraph>
        ) : null}
      </div>

      <Tabs items={tabItems} />

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
