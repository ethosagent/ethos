import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Radio, Select, Space, Spin, Steps, Typography } from 'antd';
import { useState } from 'react';
import { rpc } from '../../rpc';

type Step = 'preset' | 'connecting' | 'done' | 'error';

// v1 presets — curated list
const PRESETS = [{ value: 'linear', label: 'Linear', url: 'https://mcp.linear.app/mcp' }];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AddMcpModal({ open, onClose }: Props) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('preset');
  const [preset, setPreset] = useState<string | undefined>();
  const [serverName, setServerName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [customUrl, setCustomUrl] = useState('');
  const [customName, setCustomName] = useState('');
  const [serverType, setServerType] = useState<'oauth' | 'direct'>('oauth');
  const [bearerToken, setBearerToken] = useState('');

  // Start mutation — calls mcp.start to trigger discovery + definition write,
  // then cancels the pending session (we only want the definition, not auth).
  const startMutation = useMutation({
    mutationFn: (input: { url: string; name?: string }) => rpc.mcp.start(input),
    onSuccess: (result) => {
      if (!result.ok) {
        setStep('error');
        setErrorMsg(('detail' in result ? result.detail : result.code) ?? 'Discovery failed');
        return;
      }
      setServerName(result.serverName);
      // Cancel the pending session — we don't want to open the auth flow.
      rpc.mcp.cancel({ state: result.state }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
      setStep('done');
    },
    onError: (err) => {
      setStep('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    },
  });

  const addServerMutation = useMutation({
    mutationFn: (input: {
      url: string;
      name: string;
      transport: 'streamable-http';
      token?: string;
    }) => rpc.mcp.addServer(input),
    onSuccess: (result) => {
      if (!result.ok) {
        setStep('error');
        setErrorMsg(('detail' in result ? result.detail : result.code) ?? 'Failed to add server');
        return;
      }
      setServerName(result.serverName);
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
      queryClient.invalidateQueries({ queryKey: ['mcp', 'list'] });
      setStep('done');
    },
    onError: (err) => {
      setStep('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    },
  });

  // Reset state when modal opens
  const handleOpen = () => {
    setStep('preset');
    setPreset(undefined);
    setServerName('');
    setErrorMsg('');
    setMode('preset');
    setCustomUrl('');
    setCustomName('');
    setServerType('oauth');
    setBearerToken('');
  };

  const handleClose = () => {
    onClose();
  };

  const handleConnect = () => {
    setStep('connecting');
    if (mode === 'preset') {
      const selected = PRESETS.find((p) => p.value === preset);
      if (!selected) return;
      startMutation.mutate({ url: selected.url });
    } else if (serverType === 'oauth') {
      startMutation.mutate({
        url: customUrl.trim(),
        ...(customName.trim() ? { name: customName.trim() } : {}),
      });
    } else {
      addServerMutation.mutate({
        url: customUrl.trim(),
        name: customName.trim(),
        transport: 'streamable-http',
        ...(bearerToken.trim() ? { token: bearerToken.trim() } : {}),
      });
    }
  };

  const isConnectDisabled =
    mode === 'preset'
      ? !preset
      : serverType === 'direct'
        ? !customUrl.trim() || !customName.trim()
        : !customUrl.trim();

  const currentStepIndex =
    step === 'preset' ? 0 : step === 'connecting' ? 1 : step === 'done' ? 2 : 1;

  return (
    <Modal
      open={open}
      title="Add MCP Server"
      onCancel={handleClose}
      footer={null}
      width={480}
      destroyOnClose
      afterOpenChange={(visible) => {
        if (visible) handleOpen();
      }}
    >
      <Steps
        current={currentStepIndex}
        size="small"
        style={{ marginBottom: 24 }}
        items={[{ title: 'Select' }, { title: 'Register' }, { title: 'Done' }]}
      />

      {step === 'preset' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Typography.Text>How would you like to add a server?</Typography.Text>
          <Radio.Group
            value={mode}
            onChange={(e) => setMode(e.target.value as 'preset' | 'custom')}
            optionType="button"
            buttonStyle="solid"
            style={{ width: '100%', display: 'flex' }}
          >
            <Radio.Button value="preset" style={{ flex: 1, textAlign: 'center' }}>
              Preset
            </Radio.Button>
            <Radio.Button value="custom" style={{ flex: 1, textAlign: 'center' }}>
              Custom URL
            </Radio.Button>
          </Radio.Group>

          {mode === 'preset' ? (
            <Select
              placeholder="Select a preset"
              value={preset}
              onChange={setPreset}
              options={PRESETS}
              style={{ width: '100%' }}
            />
          ) : (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input
                placeholder="https://mcp.example.com/mcp"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                allowClear
              />
              <Input
                placeholder="Server name (e.g. my-server)"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                allowClear
              />
              <div>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12, display: 'block', marginBottom: 6 }}
                >
                  Authentication
                </Typography.Text>
                <Radio.Group
                  value={serverType}
                  onChange={(e) => setServerType(e.target.value as 'oauth' | 'direct')}
                  style={{ width: '100%' }}
                >
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Radio value="oauth">OAuth 2.0 (server handles login flow)</Radio>
                    <Radio value="direct">Plain HTTP / Bearer token</Radio>
                  </Space>
                </Radio.Group>
              </div>
              {serverType === 'direct' && (
                <Input.Password
                  placeholder="Bearer token (optional)"
                  value={bearerToken}
                  onChange={(e) => setBearerToken(e.target.value)}
                  allowClear
                />
              )}
              {serverType === 'oauth' && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  The server must support OAuth 2.0 discovery. You'll be redirected to authorize.
                </Typography.Text>
              )}
              {serverType === 'direct' && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Connects directly without OAuth. If the server requires a token, paste it above.
                </Typography.Text>
              )}
            </Space>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={handleClose}>Cancel</Button>
            <Button type="primary" disabled={isConnectDisabled} onClick={handleConnect}>
              Register
            </Button>
          </div>
        </Space>
      )}

      {step === 'connecting' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin size="large" />
          <Typography.Paragraph style={{ marginTop: 16 }}>
            {serverType === 'direct' ? 'Adding server…' : 'Discovering OAuth metadata…'}
          </Typography.Paragraph>
        </div>
      )}

      {step === 'done' && (
        <Space direction="vertical" style={{ width: '100%', textAlign: 'center' }} size="middle">
          <Alert
            type="success"
            message={`${serverName} registered`}
            description="Server definition saved. Attach it to a personality and run login to authenticate."
          />
          <Button type="primary" onClick={handleClose}>
            Close
          </Button>
        </Space>
      )}

      {step === 'error' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Alert type="error" message="Registration Failed" description={errorMsg} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={handleClose}>Close</Button>
            <Button onClick={() => setStep('preset')}>Retry</Button>
          </div>
        </Space>
      )}
    </Modal>
  );
}
