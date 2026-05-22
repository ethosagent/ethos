import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, List, Modal, Space, Spin, Steps, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../../rpc';

interface ConnectMcpModalProps {
  open: boolean;
  personalityId: string;
  existingServers: string[];
  onClose: () => void;
  onConnected: () => void;
}

type Step = 'select' | 'connecting' | 'oauth' | 'done';

const OAUTH_POPUP_WIDTH = 520;
const OAUTH_POPUP_HEIGHT = 720;
const OAUTH_RETURN_KEY = 'ethos:mcp_oauth_return';

export function ConnectMcpModal({
  open,
  personalityId,
  existingServers,
  onClose,
  onConnected,
}: ConnectMcpModalProps) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('select');
  const [selected, setSelected] = useState<string | null>(null);
  const [oauthState, setOauthState] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const popupRef = useRef<Window | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch global server registry
  const { data: listData, isLoading: listLoading } = useQuery({
    queryKey: ['mcp', 'list'],
    queryFn: () => rpc.mcp.list(),
    enabled: open,
  });

  // Filter out already-attached servers
  const availableServers = (listData?.servers ?? []).filter(
    (s) => !existingServers.includes(s.name),
  );

  const finishConnect = useCallback(() => {
    setStep('done');
    qc.invalidateQueries({ queryKey: ['mcp', 'personalityServers', personalityId] });
    qc.invalidateQueries({ queryKey: ['personalities', 'get', personalityId] });
    onConnected();
  }, [qc, personalityId, onConnected]);

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
          finishConnect();
        } else if (result.status === 'error') {
          stopPolling();
          setErrorMsg(result.error ?? 'Connection failed');
          setStep('select');
        } else if (result.status === 'expired') {
          stopPolling();
          setErrorMsg('Authorization session expired. Please retry.');
          setStep('select');
        }
      } catch {
        // Keep polling
      }
    }, 2000);
  }, [stopPolling, finishConnect]);

  // Listen for postMessage from OAuth popup
  useEffect(() => {
    if (step !== 'oauth') return;

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const msg = event.data as Record<string, unknown> | null;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ethos:mcp_oauth_success' && msg.state === oauthState) {
        stopPolling();
        finishConnect();
      } else if (msg.type === 'ethos:mcp_oauth_error' && msg.state === oauthState) {
        stopPolling();
        const detail = typeof msg.detail === 'string' ? msg.detail : undefined;
        const code = typeof msg.code === 'string' ? msg.code : undefined;
        setErrorMsg(detail ?? code ?? 'OAuth failed');
        setStep('select');
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [step, oauthState, stopPolling, finishConnect]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setStep('select');
      setSelected(null);
      setOauthState('');
      setErrorMsg('');
    }
  }, [open]);

  // Add server to personality's mcp_servers
  const addMut = useMutation({
    mutationFn: (serverName: string) =>
      rpc.personalities.update({
        id: personalityId,
        mcp_servers: [...existingServers, serverName],
      }),
    onSuccess: async (_result, serverName) => {
      // Check if this server needs OAuth
      const server = (listData?.servers ?? []).find((s) => s.name === serverName);
      // Non-OAuth servers (no url, or already authorized globally) -> done
      if (!server?.url || server.auth_status === 'authorized' || server.auth_status === 'none') {
        finishConnect();
        return;
      }
      // OAuth server - start auth flow
      setStep('connecting');
      startOAuth(serverName, server.url);
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    },
  });

  const startOAuth = async (serverName: string, url: string) => {
    try {
      const result = await rpc.mcp.start({ url, personalityId, name: serverName });
      if (!result.ok) {
        setErrorMsg('detail' in result ? (result.detail ?? result.code) : result.code);
        setStep('select');
        return;
      }
      setOauthState(result.state);
      setStep('oauth');
      const popup = window.open(
        result.authorizeUrl,
        '_blank',
        `width=${OAUTH_POPUP_WIDTH},height=${OAUTH_POPUP_HEIGHT}`,
      );
      if (!popup || popup.closed) {
        // Popup blocked - fall back to same-tab navigation
        sessionStorage.setItem(OAUTH_RETURN_KEY, `/personalities/${personalityId}`);
        window.location.href = result.authorizeUrl;
        return;
      }
      popupRef.current = popup;
      startPolling();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('select');
    }
  };

  const handleSelect = (serverName: string) => {
    setSelected(serverName);
    setErrorMsg('');
    addMut.mutate(serverName);
  };

  const handleClose = () => {
    stopPolling();
    if (step === 'oauth' && oauthState) {
      rpc.mcp.cancel({ state: oauthState }).catch(() => {});
    }
    onClose();
  };

  const currentStepIndex =
    step === 'select' ? 0 : step === 'connecting' || step === 'oauth' ? 1 : 2;

  return (
    <Modal
      open={open}
      title="Connect MCP Server"
      onCancel={handleClose}
      footer={null}
      width={480}
      destroyOnClose
    >
      <Steps
        current={currentStepIndex}
        size="small"
        style={{ marginBottom: 24 }}
        items={[{ title: 'Select' }, { title: 'Authorize' }, { title: 'Done' }]}
      />

      {step === 'select' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {errorMsg ? (
            <Alert type="error" message={errorMsg} closable onClose={() => setErrorMsg('')} />
          ) : null}

          {listLoading ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <Spin />
            </div>
          ) : availableServers.length === 0 ? (
            <Alert
              type="info"
              message="No servers available"
              description="Register one from the Plugins page first."
            />
          ) : (
            <List
              bordered
              size="small"
              dataSource={availableServers}
              renderItem={(server) => (
                <List.Item
                  actions={[
                    <Button
                      key="connect"
                      size="small"
                      type="primary"
                      loading={addMut.isPending && selected === server.name}
                      onClick={() => handleSelect(server.name)}
                    >
                      Connect
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <span>
                        {server.name}
                        {server.transport ? (
                          <Tag bordered={false} style={{ fontSize: 11, marginLeft: 8 }}>
                            {server.transport}
                          </Tag>
                        ) : null}
                        {server.transport === 'sse' ? (
                          <Tag
                            color="warning"
                            bordered={false}
                            style={{ fontSize: 11, marginLeft: 4 }}
                          >
                            deprecated
                          </Tag>
                        ) : null}
                      </span>
                    }
                    description={
                      server.url ? (
                        <Typography.Text
                          type="secondary"
                          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
                        >
                          {server.url}
                        </Typography.Text>
                      ) : server.command ? (
                        <Typography.Text
                          type="secondary"
                          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
                        >
                          {server.command}
                        </Typography.Text>
                      ) : null
                    }
                  />
                </List.Item>
              )}
            />
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={handleClose}>Cancel</Button>
          </div>
        </Space>
      )}

      {step === 'connecting' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin size="large" />
          <Typography.Paragraph style={{ marginTop: 16 }}>
            Starting OAuth flow...
          </Typography.Paragraph>
        </div>
      )}

      {step === 'oauth' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Alert
            type="info"
            message="Complete sign-in in the new window"
            description="We'll continue automatically when you return."
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={handleClose}>Cancel</Button>
          </div>
        </Space>
      )}

      {step === 'done' && (
        <Space direction="vertical" style={{ width: '100%', textAlign: 'center' }} size="middle">
          <Alert
            type="success"
            message={`${selected} connected`}
            description="The server is now attached to this personality."
          />
          <Button type="primary" onClick={handleClose}>
            Close
          </Button>
        </Space>
      )}
    </Modal>
  );
}
