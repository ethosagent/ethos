import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Modal, Select, Space, Spin, Steps, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../../rpc';

type Step = 'preset' | 'connecting' | 'oauth' | 'attach' | 'done' | 'error';

const MODAL_STATE_KEY = 'ethos:mcp_modal_state';

// v1 presets — curated list; custom URLs deferred
const PRESETS = [{ value: 'linear', label: 'Linear', url: 'https://mcp.linear.app/mcp' }];

/** Popup window geometry for the OAuth consent screen. */
const OAUTH_POPUP_WIDTH = 520;
const OAUTH_POPUP_HEIGHT = 720;

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AddMcpModal({ open, onClose }: Props) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('preset');
  const [preset, setPreset] = useState<string | undefined>();
  const [serverName, setServerName] = useState('');
  const [state, setState] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [selectedPersonalities, setSelectedPersonalities] = useState<string[]>([]);
  const popupRef = useRef<Window | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch personalities for the attach step
  const { data: personalitiesData } = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
    enabled: step === 'attach',
  });
  const personalities = personalitiesData?.items ?? [];

  // Start mutation — calls mcp.start
  const startMutation = useMutation({
    mutationFn: (input: { url: string; name?: string }) => rpc.mcp.start(input),
    onSuccess: (result) => {
      if (!result.ok) {
        setStep('error');
        setErrorMsg(('detail' in result ? result.detail : result.code) ?? 'Discovery failed');
        return;
      }
      setServerName(result.serverName);
      setState(result.state);
      setStep('oauth');
      // Open popup
      const popup = window.open(
        result.authorizeUrl,
        '_blank',
        `width=${OAUTH_POPUP_WIDTH},height=${OAUTH_POPUP_HEIGHT}`,
      );
      if (!popup || popup.closed) {
        // Popup blocked — fall back to same-tab navigation
        sessionStorage.setItem(
          MODAL_STATE_KEY,
          JSON.stringify({
            step: 'oauth',
            preset,
            serverName: result.serverName,
            state: result.state,
          }),
        );
        window.location.href = result.authorizeUrl;
        return;
      }
      popupRef.current = popup;
      startPolling();
    },
    onError: (err) => {
      setStep('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    },
  });

  // Attach mutation
  const attachMutation = useMutation({
    mutationFn: (input: { serverName: string; personalityIds: string[] }) =>
      rpc.mcp.attachPersonalities(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
      queryClient.invalidateQueries({ queryKey: ['personalities'] });
      setStep('done');
    },
  });

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // Listen for postMessage from popup
  useEffect(() => {
    if (step !== 'oauth') return;

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'ethos:mcp_oauth_success' && data.state === state) {
        stopPolling();
        if (typeof data.serverName === 'string') {
          setServerName(data.serverName);
        }
        setStep('attach');
      } else if (data.type === 'ethos:mcp_oauth_error' && data.state === state) {
        stopPolling();
        setStep('error');
        const detail = typeof data.detail === 'string' ? data.detail : undefined;
        const code = typeof data.code === 'string' ? data.code : undefined;
        setErrorMsg(detail ?? code ?? 'OAuth failed');
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [step, state, stopPolling]);

  // Polling fallback for when popup closes without postMessage
  const startPolling = useCallback(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(async () => {
      try {
        const result = await rpc.mcp.status();
        if (result.status === 'connected') {
          stopPolling();
          setStep('attach');
        } else if (result.status === 'error') {
          stopPolling();
          setStep('error');
          setErrorMsg(result.error ?? 'Connection failed');
        }
      } catch {
        // Keep polling
      }
    }, 2000);
  }, [stopPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // Reset state when modal opens — check for rehydration from same-tab fallback
  useEffect(() => {
    if (open) {
      const saved = sessionStorage.getItem(MODAL_STATE_KEY);
      if (saved) {
        sessionStorage.removeItem(MODAL_STATE_KEY);
        try {
          const restored = JSON.parse(saved) as {
            serverName?: string;
            state?: string;
            preset?: string;
          };
          if (restored.serverName && restored.state) {
            setServerName(restored.serverName);
            setState(restored.state);
            setPreset(restored.preset);
            setStep('attach');
            return;
          }
        } catch {
          /* corrupted — start fresh */
        }
      }
      setStep('preset');
      setPreset(undefined);
      setServerName('');
      setState('');
      setErrorMsg('');
      setSelectedPersonalities([]);
    }
  }, [open]);

  const handleClose = () => {
    stopPolling();
    if (step === 'oauth' && state) {
      rpc.mcp.cancel({ state }).catch(() => {});
    }
    onClose();
  };

  const handleConnect = () => {
    const selected = PRESETS.find((p) => p.value === preset);
    if (!selected) return;
    setStep('connecting');
    startMutation.mutate({ url: selected.url });
  };

  const handleAttach = () => {
    if (selectedPersonalities.length === 0) {
      setStep('done');
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
      return;
    }
    attachMutation.mutate({ serverName, personalityIds: selectedPersonalities });
  };

  const currentStepIndex =
    step === 'preset'
      ? 0
      : step === 'connecting' || step === 'oauth'
        ? 1
        : step === 'attach'
          ? 2
          : step === 'done'
            ? 3
            : 1;

  return (
    <Modal
      open={open}
      title="Add MCP Server"
      onCancel={handleClose}
      footer={null}
      width={480}
      destroyOnClose
    >
      <Steps
        current={currentStepIndex}
        size="small"
        style={{ marginBottom: 24 }}
        items={[
          { title: 'Select' },
          { title: 'Authorize' },
          { title: 'Attach' },
          { title: 'Done' },
        ]}
      />

      {step === 'preset' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Typography.Text>Choose an MCP server to connect:</Typography.Text>
          <Select
            placeholder="Select a preset"
            value={preset}
            onChange={setPreset}
            options={PRESETS}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={handleClose}>Cancel</Button>
            <Button type="primary" disabled={!preset} onClick={handleConnect}>
              Connect
            </Button>
          </div>
        </Space>
      )}

      {step === 'connecting' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin size="large" />
          <Typography.Paragraph style={{ marginTop: 16 }}>
            Discovering OAuth metadata...
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

      {step === 'attach' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Alert
            type="success"
            message={`Connected to ${serverName}`}
            style={{ marginBottom: 8 }}
          />
          <Typography.Text>Attach to personalities:</Typography.Text>
          <Checkbox.Group
            value={selectedPersonalities}
            onChange={(vals) => setSelectedPersonalities(vals as string[])}
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {personalities.map((p) => (
              <Checkbox key={p.id} value={p.id}>
                {p.name ?? p.id}
              </Checkbox>
            ))}
          </Checkbox.Group>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button
              onClick={() => {
                setStep('done');
                queryClient.invalidateQueries({ queryKey: ['plugins'] });
              }}
            >
              Skip
            </Button>
            <Button type="primary" loading={attachMutation.isPending} onClick={handleAttach}>
              Finish
            </Button>
          </div>
        </Space>
      )}

      {step === 'done' && (
        <Space direction="vertical" style={{ width: '100%', textAlign: 'center' }} size="middle">
          <Alert
            type="success"
            message={`${serverName} is ready`}
            description={
              selectedPersonalities.length > 0
                ? `Attached to ${selectedPersonalities.length} personality(ies).`
                : 'You can attach it to personalities from the Personalities tab.'
            }
          />
          <Button type="primary" onClick={handleClose}>
            Close
          </Button>
        </Space>
      )}

      {step === 'error' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Alert type="error" message="Connection Failed" description={errorMsg} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={handleClose}>Close</Button>
            <Button onClick={() => setStep('preset')}>Retry</Button>
          </div>
        </Space>
      )}
    </Modal>
  );
}
