import type { McpAddServerInput } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Steps,
  Typography,
} from 'antd';
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
  const [mode, setMode] = useState<'preset' | 'custom' | 'stdio'>('preset');
  const [customUrl, setCustomUrl] = useState('');
  const [customName, setCustomName] = useState('');
  const [serverType, setServerType] = useState<'oauth' | 'direct'>('oauth');
  const [bearerToken, setBearerToken] = useState('');
  const [stdioCommand, setStdioCommand] = useState('');
  const [stdioArgs, setStdioArgs] = useState('');
  const [stdioName, setStdioName] = useState('');
  const [resultLimit, setResultLimit] = useState<number | null>(null);

  // Start mutation — calls mcp.start to trigger discovery + definition write.
  // The placeholder written by mcp.start() persists in mcp.json as a valid
  // registration; auth happens later via the ConnectMcpModal OAuth flow.
  const startMutation = useMutation({
    mutationFn: (input: { url: string; name?: string }) => rpc.mcp.start(input),
    onSuccess: (result) => {
      if (!result.ok) {
        setStep('error');
        setErrorMsg(('detail' in result ? result.detail : result.code) ?? 'Discovery failed');
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

  const addServerMutation = useMutation({
    mutationFn: (input: McpAddServerInput) => rpc.mcp.addServer(input),
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
    setStdioCommand('');
    setStdioArgs('');
    setStdioName('');
    setResultLimit(null);
  };

  const handleClose = () => {
    onClose();
  };

  const handleConnect = async () => {
    setErrorMsg('');

    // Issue 10: client-side validation before submit
    if (mode === 'custom' || mode === 'stdio') {
      try {
        const validation = await rpc.mcp.validateConfig({
          transport: mode === 'stdio' ? 'stdio' : 'streamable-http',
          ...(mode === 'custom' ? { url: customUrl.trim() } : {}),
          ...(mode === 'stdio' ? { command: stdioCommand.trim() } : {}),
          name: mode === 'stdio' ? stdioName.trim() : customName.trim(),
        });
        if (!validation.valid) {
          setErrorMsg(validation.errors.map((e) => `${e.field}: ${e.message}`).join(', '));
          return;
        }
      } catch {
        // Validation endpoint unavailable — proceed anyway
      }
    }

    setStep('connecting');
    if (mode === 'preset') {
      const selected = PRESETS.find((p) => p.value === preset);
      if (!selected) return;
      startMutation.mutate({ url: selected.url });
    } else if (mode === 'stdio') {
      addServerMutation.mutate({
        name: stdioName.trim(),
        transport: 'stdio',
        command: stdioCommand.trim(),
        ...(stdioArgs.trim()
          ? {
              args: stdioArgs
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean),
            }
          : {}),
        ...(resultLimit ? { mcpResultLimitChars: resultLimit } : {}),
      });
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
        authType: 'bearer',
        ...(bearerToken.trim() ? { token: bearerToken.trim() } : {}),
        ...(resultLimit ? { mcpResultLimitChars: resultLimit } : {}),
      });
    }
  };

  const isConnectDisabled =
    mode === 'preset'
      ? !preset
      : mode === 'stdio'
        ? !stdioCommand.trim() || !stdioName.trim()
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
            onChange={(e) => setMode(e.target.value as 'preset' | 'custom' | 'stdio')}
            optionType="button"
            buttonStyle="solid"
            style={{ width: '100%', display: 'flex' }}
          >
            <Radio.Button value="preset" style={{ flex: 1, textAlign: 'center' }}>
              Preset
            </Radio.Button>
            <Radio.Button value="custom" style={{ flex: 1, textAlign: 'center' }}>
              Remote URL
            </Radio.Button>
            <Radio.Button value="stdio" style={{ flex: 1, textAlign: 'center' }}>
              Local Command
            </Radio.Button>
          </Radio.Group>

          {errorMsg && step === 'preset' ? (
            <Alert
              type="error"
              message={errorMsg}
              closable
              onClose={() => setErrorMsg('')}
              style={{ marginBottom: 0 }}
            />
          ) : null}

          {mode === 'preset' ? (
            <Select
              placeholder="Select a preset"
              value={preset}
              onChange={setPreset}
              options={PRESETS}
              style={{ width: '100%' }}
            />
          ) : mode === 'stdio' ? (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input
                placeholder="Command (e.g. npx, python)"
                value={stdioCommand}
                onChange={(e) => setStdioCommand(e.target.value)}
                allowClear
              />
              <Input
                placeholder="Args (comma-separated, optional)"
                value={stdioArgs}
                onChange={(e) => setStdioArgs(e.target.value)}
                allowClear
              />
              <Input
                placeholder="Server name (required)"
                value={stdioName}
                onChange={(e) => setStdioName(e.target.value)}
                allowClear
              />
              <InputNumber
                placeholder="50000"
                value={resultLimit}
                onChange={(v) => setResultLimit(v)}
                min={1}
                style={{ width: '100%' }}
                addonBefore={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Result size limit (chars)
                  </Typography.Text>
                }
              />
            </Space>
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
              <InputNumber
                placeholder="50000"
                value={resultLimit}
                onChange={(v) => setResultLimit(v)}
                min={1}
                style={{ width: '100%' }}
                addonBefore={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Result size limit (chars)
                  </Typography.Text>
                }
              />
              {serverType === 'oauth' && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  The server must support OAuth 2.0 discovery. You'll be redirected to authorize.
                </Typography.Text>
              )}
              {serverType === 'direct' && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Connects directly without OAuth. Paste the token now or set it later on the
                  personality page.
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
            {mode === 'stdio'
              ? 'Adding local server…'
              : serverType === 'direct'
                ? 'Adding server…'
                : 'Discovering OAuth metadata…'}
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
