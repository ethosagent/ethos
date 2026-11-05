import { App as AntApp, Button, Modal, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { type McpDeviceFlow, useMcpDeviceLogin } from '../../features/mcp/useMcpDeviceLogin';

// "Sign in with a code" modal (plan mcp-device-code-login §7.2, D13). Names the
// server host, the authorization host and the personality so the user reads
// before typing the code; nothing is opened automatically — the verification
// URI is a plain link the user clicks.

interface Props {
  open: boolean;
  serverName: string;
  personalityId?: string;
  onClose: () => void;
  onConnected: () => void;
}

const UNSUPPORTED =
  'This server does not support code sign-in. Use Sign in, or set webBaseUrl if this page is not on localhost.';

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = new Date(expiresAt).getTime() - now;
  return (
    <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {remaining > 0 ? `Code expires in ${formatRemaining(remaining)}` : 'Code expired'}
    </Typography.Text>
  );
}

function Waiting({ flow }: { flow: McpDeviceFlow }) {
  const { message } = AntApp.useApp();
  const copy = () => {
    void navigator.clipboard?.writeText(flow.userCode);
    message.success('Code copied');
  };
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Paragraph style={{ margin: 0 }}>
        Signing in to <strong>{flow.serverName}</strong> ({flow.serverHost}) through{' '}
        <strong>{flow.authHost}</strong>
        {flow.personalityId ? (
          <>
            {' '}
            for personality <strong>{flow.personalityId}</strong>
          </>
        ) : (
          ' for all personalities'
        )}
        . Only continue if you started this.
      </Typography.Paragraph>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          data-testid="device-user-code"
          style={{
            fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 28,
            letterSpacing: '0.08em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {flow.userCode}
        </span>
        <Button size="small" onClick={copy}>
          Copy
        </Button>
      </div>
      <Typography.Paragraph style={{ margin: 0 }}>
        Open{' '}
        <a href={flow.verificationUri} target="_blank" rel="noopener noreferrer">
          {flow.verificationUri}
        </a>{' '}
        and enter the code.
      </Typography.Paragraph>
      <Countdown expiresAt={flow.expiresAt} />
    </Space>
  );
}

export function McpDeviceLoginModal({
  open,
  serverName,
  personalityId,
  onClose,
  onConnected,
}: Props) {
  const { phase, start, cancel } = useMcpDeviceLogin({
    serverName,
    ...(personalityId ? { personalityId } : {}),
    onConnected,
  });

  // Start once per open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: start identity changes with props; run once per open
  useEffect(() => {
    if (open) void start();
  }, [open]);

  const close = () => {
    cancel();
    onClose();
  };

  let body: React.ReactNode;
  switch (phase.kind) {
    case 'waiting':
      body = <Waiting flow={phase.flow} />;
      break;
    case 'refused':
      body = (
        <Typography.Paragraph style={{ margin: 0 }}>
          {phase.code === 'device_unavailable' || phase.code === 'device_refused'
            ? UNSUPPORTED
            : `Could not start sign-in (${phase.code}${phase.detail ? `: ${phase.detail}` : ''}).`}
        </Typography.Paragraph>
      );
      break;
    case 'done':
      body = (
        <Typography.Paragraph style={{ margin: 0 }}>
          {phase.status === 'connected'
            ? 'Connected.'
            : `Sign-in ${phase.status}${phase.reason ? ` (${phase.reason})` : ''}. Close this and try again.`}
        </Typography.Paragraph>
      );
      break;
    default:
      body = <Typography.Text type="secondary">Requesting a code...</Typography.Text>;
  }

  return (
    <Modal open={open} title="Sign in with a code" onCancel={close} footer={null} destroyOnHidden>
      {body}
    </Modal>
  );
}
