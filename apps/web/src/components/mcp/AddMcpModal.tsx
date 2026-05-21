import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Modal, Select, Space, Spin, Steps, Typography } from 'antd';
import { useState } from 'react';
import { rpc } from '../../rpc';

type Step = 'preset' | 'connecting' | 'done' | 'error';

// v1 presets — curated list; custom URLs deferred
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

  // Reset state when modal opens
  const handleOpen = () => {
    setStep('preset');
    setPreset(undefined);
    setServerName('');
    setErrorMsg('');
  };

  const handleClose = () => {
    onClose();
  };

  const handleConnect = () => {
    const selected = PRESETS.find((p) => p.value === preset);
    if (!selected) return;
    setStep('connecting');
    startMutation.mutate({ url: selected.url });
  };

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
          <Typography.Text>Choose an MCP server to register:</Typography.Text>
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
              Register
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
