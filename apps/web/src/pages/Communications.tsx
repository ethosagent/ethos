import type {
  BotBinding,
  SlackAppEntry,
  TelegramBotEntry,
  WhatsAppEntry,
} from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Divider,
  Form,
  Input,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { rpc } from '../rpc';

type BindType = 'personality' | 'team';

interface AddBotFormValues {
  token?: string;
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  bindType: BindType;
  bindName: string;
}

type PlatformTabId = 'telegram' | 'slack' | 'discord' | 'email' | 'whatsapp';

const PLATFORM_TABS: { id: PlatformTabId; label: string; icon: string; description: string }[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    icon: '✈',
    description: 'Connect your Telegram bots to receive and send messages through Ethos.',
  },
  {
    id: 'slack',
    label: 'Slack',
    icon: '#',
    description: 'Connect your Slack workspace to receive and send messages through Ethos.',
  },
  {
    id: 'discord',
    label: 'Discord',
    icon: '🎮',
    description: 'Connect your Discord server to receive and send messages through Ethos.',
  },
  {
    id: 'email',
    label: 'Email',
    icon: '✉',
    description: 'Configure SMTP/IMAP to receive and send email messages through Ethos.',
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: '📱',
    description: 'Connect your WhatsApp number to receive and send messages through Ethos.',
  },
];

// ---------------------------------------------------------------------------
// Label prefix badge (personality / team)
// ---------------------------------------------------------------------------

function LabelPrefixBadge({ type }: { type: 'personality' | 'team' }) {
  const isPersonality = type === 'personality';
  return (
    <span
      style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
        textTransform: 'uppercase',
        background: isPersonality ? 'rgba(74,158,255,0.12)' : 'rgba(245,158,11,0.12)',
        color: isPersonality ? 'var(--blue)' : 'var(--amber)',
        padding: '1px 5px',
        borderRadius: 3,
      }}
    >
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Platform stub (unconnected state)
// ---------------------------------------------------------------------------

function PlatformStub({
  icon,
  name,
  description,
  onConnect,
}: {
  icon: string;
  name: string;
  description: string;
  onConnect: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 300,
        gap: 12,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          backgroundColor: 'var(--bg-elevated)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 20,
        }}
      >
        {icon}
      </div>
      <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--text-primary)' }}>{name}</div>
      <div
        style={{
          fontSize: 13,
          color: 'var(--text-secondary)',
          textAlign: 'center',
          maxWidth: 300,
        }}
      >
        {description}
      </div>
      <Button
        type="primary"
        size="small"
        style={{ fontSize: 12, padding: '8px 14px', height: 'auto' }}
        onClick={onConnect}
      >
        Connect {name}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Masked token preview
// ---------------------------------------------------------------------------

function TokenPreview({ tokenConfigured, botKey }: { tokenConfigured: boolean; botKey: string }) {
  const lastFour = botKey.length >= 4 ? botKey.slice(-4) : botKey;
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--text-secondary)',
      }}
    >
      {tokenConfigured ? `••••••${lastFour}` : '—'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status dot inline
// ---------------------------------------------------------------------------

function StatusIndicator({
  status,
}: {
  status: 'connected' | 'disconnected' | 'error' | 'not-configured';
}) {
  const colorMap: Record<string, string> = {
    connected: 'var(--green)',
    disconnected: 'var(--text-tertiary)',
    error: 'var(--red)',
    'not-configured': 'var(--text-tertiary)',
  };
  const labelMap: Record<string, string> = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    error: 'Error',
    'not-configured': 'Not configured',
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          backgroundColor: colorMap[status] ?? 'var(--text-tertiary)',
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        {labelMap[status] ?? status}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Telegram panel
// ---------------------------------------------------------------------------

function TelegramPanel() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [adding, setAdding] = useState(false);
  const [bindType, setBindType] = useState<BindType>('personality');
  const [form] = Form.useForm<AddBotFormValues>();

  const botsQuery = useQuery({
    queryKey: ['platforms', 'bots', 'telegram'],
    queryFn: () => rpc.platforms.botsListTelegram(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
    enabled: adding,
  });

  const teamsQuery = useQuery({
    queryKey: ['kanban', 'list'],
    queryFn: () => rpc.kanban.list(),
    enabled: adding && bindType === 'team',
  });

  const addMut = useMutation({
    mutationFn: (values: AddBotFormValues) =>
      rpc.platforms.botsAddTelegram({
        token: values.token ?? '',
        bind: { type: values.bindType, name: values.bindName } satisfies BotBinding,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'telegram'] });
      notification.success({ message: 'Telegram bot added', placement: 'topRight' });
      form.resetFields();
      setAdding(false);
    },
    onError: (err) =>
      notification.error({ message: 'Add failed', description: (err as Error).message }),
  });

  const removeMut = useMutation({
    mutationFn: (botKey: string) => rpc.platforms.botsRemoveTelegram({ botKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'telegram'] });
      notification.info({ message: 'Telegram bot removed', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Remove failed', description: (err as Error).message }),
  });

  const bots: TelegramBotEntry[] = botsQuery.data?.bots ?? [];

  const columns = [
    {
      title: 'TOKEN PREVIEW',
      key: 'tokenPreview',
      width: 160,
      render: (_: unknown, row: TelegramBotEntry) => (
        <TokenPreview tokenConfigured={row.tokenConfigured} botKey={row.botKey} />
      ),
    },
    {
      title: 'PERSONALITY / TEAM',
      key: 'bind',
      render: (_: unknown, row: TelegramBotEntry) => (
        <Space size={6}>
          <LabelPrefixBadge type={row.bind.type as 'personality' | 'team'} />
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{row.bind.name}</span>
        </Space>
      ),
    },
    {
      title: 'STATUS',
      key: 'status',
      width: 100,
      render: (_: unknown, row: TelegramBotEntry) => (
        <StatusIndicator status={row.tokenConfigured ? 'connected' : 'disconnected'} />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, row: TelegramBotEntry) => (
        <Popconfirm
          title="Remove this bot?"
          description="The bot token and binding will be deleted from config."
          okText="Remove"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeMut.mutate(row.botKey)}
        >
          <Button size="small" type="text" danger style={{ fontSize: 14 }}>
            {'×'}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const bindOptions =
    bindType === 'personality'
      ? (personalitiesQuery.data?.items ?? []).map((p) => ({
          label: p.name,
          value: p.id,
        }))
      : (teamsQuery.data?.teams ?? []).map((t) => ({
          label: t.name,
          value: t.name,
        }));

  if (botsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {bots.length} bot{bots.length !== 1 ? 's' : ''} configured
        </span>
        <Button type="primary" size="small" onClick={() => setAdding(true)}>
          + Add Telegram bot
        </Button>
      </div>

      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
        }}
      >
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  color: 'var(--text-tertiary)',
                  textAlign: 'left',
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--border-subtle)',
                  width: col.width ?? 'auto',
                }}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bots.map((bot) => (
            <tr
              key={bot.botKey}
              style={{ height: 40, borderBottom: '1px solid var(--border-subtle)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--ethos-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  style={{
                    padding: '0 12px',
                    borderBottom: '1px solid var(--border-subtle)',
                    width: col.width ?? 'auto',
                  }}
                >
                  {col.render(undefined, bot)}
                </td>
              ))}
            </tr>
          ))}
          {bots.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  padding: '24px 12px',
                  textAlign: 'center',
                  color: 'var(--text-tertiary)',
                  fontSize: 13,
                }}
              >
                No bots configured yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {adding && (
        <Card size="small" style={{ marginTop: 12, background: 'var(--ethos-bg)' }}>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ bindType: 'personality' }}
            onFinish={(values) => addMut.mutate(values)}
          >
            <Form.Item
              label="Bot token"
              name="token"
              rules={[{ required: true, message: 'Paste the token from BotFather' }]}
            >
              <Input.Password autoComplete="off" placeholder="123456:ABC-DEF..." />
            </Form.Item>

            <Form.Item label="Bind to" style={{ marginBottom: 8 }}>
              <Segmented
                options={[
                  { label: 'Personality', value: 'personality' },
                  { label: 'Team', value: 'team' },
                ]}
                value={bindType}
                onChange={(v) => {
                  const t = v as BindType;
                  setBindType(t);
                  form.setFieldValue('bindType', t);
                  form.setFieldValue('bindName', undefined);
                }}
              />
            </Form.Item>

            <Form.Item name="bindType" hidden>
              <Input />
            </Form.Item>

            <Form.Item
              name="bindName"
              rules={[{ required: true, message: `Select a ${bindType}` }]}
            >
              <Select
                placeholder={`Select ${bindType}…`}
                loading={
                  bindType === 'personality' ? personalitiesQuery.isLoading : teamsQuery.isLoading
                }
                options={bindOptions}
              />
            </Form.Item>

            <Space>
              <Button type="primary" htmlType="submit" loading={addMut.isPending}>
                Save bot
              </Button>
              <Button
                onClick={() => {
                  setAdding(false);
                  form.resetFields();
                }}
              >
                Cancel
              </Button>
            </Space>
          </Form>
        </Card>
      )}

      <AccessControlSection platform="telegram" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slack panel
// ---------------------------------------------------------------------------

function SlackPanel() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [adding, setAdding] = useState(false);
  const [bindType, setBindType] = useState<BindType>('personality');
  const [form] = Form.useForm<AddBotFormValues>();

  const botsQuery = useQuery({
    queryKey: ['platforms', 'bots', 'slack'],
    queryFn: () => rpc.platforms.botsListSlack(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
    enabled: adding,
  });

  const teamsQuery = useQuery({
    queryKey: ['kanban', 'list'],
    queryFn: () => rpc.kanban.list(),
    enabled: adding && bindType === 'team',
  });

  const addMut = useMutation({
    mutationFn: (values: AddBotFormValues) =>
      rpc.platforms.botsAddSlack({
        botToken: values.botToken ?? '',
        appToken: values.appToken ?? '',
        signingSecret: values.signingSecret ?? '',
        bind: { type: values.bindType, name: values.bindName } satisfies BotBinding,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'slack'] });
      notification.success({ message: 'Slack app added', placement: 'topRight' });
      form.resetFields();
      setAdding(false);
    },
    onError: (err) =>
      notification.error({ message: 'Add failed', description: (err as Error).message }),
  });

  const removeMut = useMutation({
    mutationFn: (botKey: string) => rpc.platforms.botsRemoveSlack({ botKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'slack'] });
      notification.info({ message: 'Slack app removed', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Remove failed', description: (err as Error).message }),
  });

  const apps: SlackAppEntry[] = botsQuery.data?.bots ?? [];

  const columns = [
    {
      title: 'TOKEN PREVIEW',
      key: 'tokenPreview',
      width: 160,
      render: (_: unknown, row: SlackAppEntry) => (
        <TokenPreview tokenConfigured={row.botTokenConfigured} botKey={row.botKey} />
      ),
    },
    {
      title: 'PERSONALITY / TEAM',
      key: 'bind',
      render: (_: unknown, row: SlackAppEntry) => (
        <Space size={6}>
          <LabelPrefixBadge type={row.bind.type as 'personality' | 'team'} />
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{row.bind.name}</span>
        </Space>
      ),
    },
    {
      title: 'STATUS',
      key: 'status',
      width: 100,
      render: (_: unknown, row: SlackAppEntry) => (
        <StatusIndicator
          status={
            row.botTokenConfigured && row.appTokenConfigured && row.signingSecretConfigured
              ? 'connected'
              : 'disconnected'
          }
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, row: SlackAppEntry) => (
        <Popconfirm
          title="Remove this Slack app?"
          description="The app tokens and binding will be deleted from config."
          okText="Remove"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeMut.mutate(row.botKey)}
        >
          <Button size="small" type="text" danger style={{ fontSize: 14 }}>
            {'×'}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const bindOptions =
    bindType === 'personality'
      ? (personalitiesQuery.data?.items ?? []).map((p) => ({
          label: p.name,
          value: p.id,
        }))
      : (teamsQuery.data?.teams ?? []).map((t) => ({
          label: t.name,
          value: t.name,
        }));

  if (botsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {apps.length} app{apps.length !== 1 ? 's' : ''} configured
        </span>
        <Button type="primary" size="small" onClick={() => setAdding(true)}>
          + Add Slack app
        </Button>
      </div>

      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
        }}
      >
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  color: 'var(--text-tertiary)',
                  textAlign: 'left',
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--border-subtle)',
                  width: col.width ?? 'auto',
                }}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {apps.map((app) => (
            <tr
              key={app.botKey}
              style={{ height: 40, borderBottom: '1px solid var(--border-subtle)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--ethos-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  style={{
                    padding: '0 12px',
                    borderBottom: '1px solid var(--border-subtle)',
                    width: col.width ?? 'auto',
                  }}
                >
                  {col.render(undefined, app)}
                </td>
              ))}
            </tr>
          ))}
          {apps.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  padding: '24px 12px',
                  textAlign: 'center',
                  color: 'var(--text-tertiary)',
                  fontSize: 13,
                }}
              >
                No Slack apps configured yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {adding && (
        <Card size="small" style={{ marginTop: 12, background: 'var(--ethos-bg)' }}>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ bindType: 'personality' }}
            onFinish={(values) => addMut.mutate(values)}
          >
            <Form.Item
              label="Bot token"
              name="botToken"
              rules={[{ required: true, message: 'Required' }]}
            >
              <Input.Password autoComplete="off" placeholder="xoxb-…" />
            </Form.Item>
            <Form.Item
              label="App token"
              name="appToken"
              rules={[{ required: true, message: 'Required' }]}
            >
              <Input.Password autoComplete="off" placeholder="xapp-…" />
            </Form.Item>
            <Form.Item
              label="Signing secret"
              name="signingSecret"
              rules={[{ required: true, message: 'Required' }]}
              extra="From Slack app dashboard → Basic Information → App Credentials."
            >
              <Input.Password autoComplete="off" />
            </Form.Item>

            <Form.Item label="Bind to" style={{ marginBottom: 8 }}>
              <Segmented
                options={[
                  { label: 'Personality', value: 'personality' },
                  { label: 'Team', value: 'team' },
                ]}
                value={bindType}
                onChange={(v) => {
                  const t = v as BindType;
                  setBindType(t);
                  form.setFieldValue('bindType', t);
                  form.setFieldValue('bindName', undefined);
                }}
              />
            </Form.Item>

            <Form.Item name="bindType" hidden>
              <Input />
            </Form.Item>

            <Form.Item
              name="bindName"
              rules={[{ required: true, message: `Select a ${bindType}` }]}
            >
              <Select
                placeholder={`Select ${bindType}…`}
                loading={
                  bindType === 'personality' ? personalitiesQuery.isLoading : teamsQuery.isLoading
                }
                options={bindOptions}
              />
            </Form.Item>

            <Space>
              <Button type="primary" htmlType="submit" loading={addMut.isPending}>
                Save app
              </Button>
              <Button
                onClick={() => {
                  setAdding(false);
                  form.resetFields();
                }}
              >
                Cancel
              </Button>
            </Space>
          </Form>
        </Card>
      )}

      <AccessControlSection platform="slack" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legacy single-bot panels (Discord, Email — unchanged from v1)
// ---------------------------------------------------------------------------

interface PlatformShape {
  id: 'discord' | 'email';
  label: string;
  fields: ReadonlyArray<{
    name: string;
    label: string;
    placeholder?: string;
    secret: boolean;
    helper?: string;
  }>;
  helpUrl?: string;
}

const LEGACY_PLATFORMS: ReadonlyArray<PlatformShape> = [
  {
    id: 'discord',
    label: 'Discord',
    fields: [
      {
        name: 'token',
        label: 'Bot token',
        secret: true,
        helper: 'Stored at discordToken in config.yaml.',
      },
    ],
    helpUrl: 'https://discord.com/developers/applications',
  },
  {
    id: 'email',
    label: 'Email',
    fields: [
      { name: 'imapHost', label: 'IMAP host', placeholder: 'imap.example.com', secret: false },
      { name: 'imapPort', label: 'IMAP port', placeholder: '993', secret: false },
      { name: 'user', label: 'Username', placeholder: 'me@example.com', secret: false },
      { name: 'password', label: 'Password / app password', secret: true },
      { name: 'smtpHost', label: 'SMTP host', placeholder: 'smtp.example.com', secret: false },
      { name: 'smtpPort', label: 'SMTP port', placeholder: '587', secret: false },
    ],
  },
];

interface AddWhatsAppFormValues {
  id: string;
  default_mode: 'mention_only' | 'all';
  owner_number: string;
  phone_number: string;
  bind_type: BindType;
  bind_name: string;
}

function WhatsAppPanel() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [adding, setAdding] = useState(false);
  const [bindType, setBindType] = useState<BindType>('personality');
  const [form] = Form.useForm<AddWhatsAppFormValues>();

  const botsQuery = useQuery({
    queryKey: ['platforms', 'bots', 'whatsapp'],
    queryFn: () => rpc.platforms.botsListWhatsApp(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
    enabled: adding,
  });

  const teamsQuery = useQuery({
    queryKey: ['kanban', 'list'],
    queryFn: () => rpc.kanban.list(),
    enabled: adding && bindType === 'team',
  });

  const addMut = useMutation({
    mutationFn: async (values: AddWhatsAppFormValues) => {
      await rpc.platforms.botsAddWhatsApp({
        id: values.id,
        defaultMode: values.default_mode,
        phoneNumber: values.phone_number.trim(),
        bind: { type: values.bind_type, name: values.bind_name } satisfies BotBinding,
      });
      // Owner number is stored on the channel filter, not the bot entry. Read
      // the current filter first so we don't clobber the allowlist or enabled flag.
      const current = await rpc.platforms.getChannelFilter({ platform: 'whatsapp' });
      const ownerUserId = `${values.owner_number.trim()}@s.whatsapp.net`;
      await rpc.platforms.setChannelFilter({
        platform: 'whatsapp',
        filter: { ...current.filter, ownerUserId },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'whatsapp'] });
      qc.invalidateQueries({ queryKey: ['platforms', 'channelFilter', 'whatsapp'] });
      qc.invalidateQueries({ queryKey: ['platforms', 'list'] });
      notification.success({ message: 'WhatsApp enabled', placement: 'topRight' });
      form.resetFields();
      setAdding(false);
    },
    onError: (err) =>
      notification.error({ message: 'Enable failed', description: (err as Error).message }),
  });

  const removeMut = useMutation({
    mutationFn: (botKey: string) => rpc.platforms.botsRemoveWhatsApp({ botKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'whatsapp'] });
      qc.invalidateQueries({ queryKey: ['platforms', 'list'] });
      notification.info({ message: 'WhatsApp bot removed', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Remove failed', description: (err as Error).message }),
  });

  const bots: WhatsAppEntry[] = botsQuery.data?.bots ?? [];

  const columns = [
    {
      title: 'TOKEN PREVIEW',
      key: 'tokenPreview',
      width: 160,
      render: (_: unknown, row: WhatsAppEntry) => (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-secondary)',
          }}
        >
          {row.botKey}
        </span>
      ),
    },
    {
      title: 'PERSONALITY / TEAM',
      key: 'bind',
      render: (_: unknown, row: WhatsAppEntry) =>
        row.bind ? (
          <Space size={6}>
            <LabelPrefixBadge type={row.bind.type as 'personality' | 'team'} />
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{row.bind.name}</span>
          </Space>
        ) : (
          <Typography.Text type="secondary">{'—'}</Typography.Text>
        ),
    },
    {
      title: 'STATUS',
      key: 'status',
      width: 100,
      render: (_: unknown, row: WhatsAppEntry) => (
        <StatusIndicator status={row.paired ? 'connected' : 'disconnected'} />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, row: WhatsAppEntry) => (
        <Space size={4}>
          {!row.paired && row.phoneNumber && (
            <Typography.Link href={`/setup/whatsapp/${row.botKey}`} style={{ fontSize: 12 }}>
              Pair
            </Typography.Link>
          )}
          <Popconfirm
            title="Remove this WhatsApp bot?"
            description="The bot's routing config will be deleted from config.yaml."
            okText="Remove"
            okButtonProps={{ danger: true }}
            onConfirm={() => removeMut.mutate(row.botKey)}
          >
            <Button size="small" type="text" danger style={{ fontSize: 14 }}>
              {'×'}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const bindOptions =
    bindType === 'personality'
      ? (personalitiesQuery.data?.items ?? []).map((p) => ({
          label: p.name,
          value: p.id,
        }))
      : (teamsQuery.data?.teams ?? []).map((t) => ({
          label: t.name,
          value: t.name,
        }));

  if (botsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {bots.length} bot{bots.length !== 1 ? 's' : ''} configured
        </span>
        <Button type="primary" size="small" onClick={() => setAdding(true)}>
          + Enable WhatsApp
        </Button>
      </div>

      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
        }}
      >
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  color: 'var(--text-tertiary)',
                  textAlign: 'left',
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--border-subtle)',
                  width: col.width ?? 'auto',
                }}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bots.map((bot) => (
            <tr
              key={bot.botKey}
              style={{ height: 40, borderBottom: '1px solid var(--border-subtle)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--ethos-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  style={{
                    padding: '0 12px',
                    borderBottom: '1px solid var(--border-subtle)',
                    width: col.width ?? 'auto',
                  }}
                >
                  {col.render(undefined, bot)}
                </td>
              ))}
            </tr>
          ))}
          {bots.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  padding: '24px 12px',
                  textAlign: 'center',
                  color: 'var(--text-tertiary)',
                  fontSize: 13,
                }}
              >
                No WhatsApp bots enabled yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {adding && (
        <Card size="small" style={{ marginTop: 12, background: 'var(--ethos-bg)' }}>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ default_mode: 'mention_only', bind_type: 'personality' }}
            onFinish={(values) => addMut.mutate(values)}
          >
            <Form.Item
              label="Name / ID"
              name="id"
              rules={[{ required: true, message: 'Give this bot a stable id' }]}
            >
              <Input autoComplete="off" placeholder="default" />
            </Form.Item>

            <Form.Item label="Reply mode" name="default_mode">
              <Select
                options={[
                  { label: 'Mention only', value: 'mention_only' },
                  { label: 'All messages', value: 'all' },
                ]}
              />
            </Form.Item>

            <Form.Item
              label="Phone number to link"
              name="phone_number"
              rules={[{ required: true, message: 'Required' }]}
              extra="The WhatsApp number this bot links to, in E.164 format without the + (e.g. 14155551234). You'll enter a pairing code on this phone."
            >
              <Input autoComplete="off" placeholder="14155551234" />
            </Form.Item>

            <Form.Item
              label="Owner number"
              name="owner_number"
              rules={[{ required: true, message: 'Required' }]}
              extra="E.164 format without the + (e.g. 14155551234). Only this number can talk to the bot until you add more under Access Control."
            >
              <Input autoComplete="off" placeholder="14155551234" />
            </Form.Item>

            <Form.Item label="Bind to" style={{ marginBottom: 8 }}>
              <Segmented
                options={[
                  { label: 'Personality', value: 'personality' },
                  { label: 'Team', value: 'team' },
                ]}
                value={bindType}
                onChange={(v) => {
                  const t = v as BindType;
                  setBindType(t);
                  form.setFieldValue('bind_type', t);
                  form.setFieldValue('bind_name', undefined);
                }}
              />
            </Form.Item>

            <Form.Item name="bind_type" hidden>
              <Input />
            </Form.Item>

            <Form.Item
              name="bind_name"
              rules={[{ required: true, message: `Select a ${bindType}` }]}
            >
              <Select
                placeholder={`Select ${bindType}…`}
                loading={
                  bindType === 'personality' ? personalitiesQuery.isLoading : teamsQuery.isLoading
                }
                options={bindOptions}
              />
            </Form.Item>

            <Space>
              <Button type="primary" htmlType="submit" loading={addMut.isPending}>
                Enable WhatsApp
              </Button>
              <Button
                onClick={() => {
                  setAdding(false);
                  form.resetFields();
                }}
              >
                Cancel
              </Button>
            </Space>
          </Form>
        </Card>
      )}

      <Alert
        type="info"
        showIcon
        message="Restart the gateway (or re-run `ethos serve`) to apply, then open the setup link next to a bot above to see its pairing code."
        style={{ marginTop: 16 }}
      />

      <AccessControlSection platform="whatsapp" />
    </div>
  );
}

function LegacyPlatformPanel({
  shape,
  status,
}: {
  shape: PlatformShape;
  status?: { configured: boolean; fields: Record<string, boolean> };
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<Record<string, string>>();

  const setMut = useMutation({
    mutationFn: (fields: Record<string, string>) => rpc.platforms.set({ id: shape.id, fields }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'list'] });
      notification.success({ message: `${shape.label} saved`, placement: 'topRight' });
      form.resetFields();
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const clearMut = useMutation({
    mutationFn: () => rpc.platforms.clear({ id: shape.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'list'] });
      notification.info({ message: `${shape.label} disconnected`, placement: 'topRight' });
      form.resetFields();
    },
    onError: (err) =>
      notification.error({ message: 'Clear failed', description: (err as Error).message }),
  });

  const onFinish = (values: Record<string, string>) => {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v && v.length > 0) cleaned[k] = v;
    }
    if (Object.keys(cleaned).length === 0) {
      notification.info({
        message: 'Nothing to save',
        description: 'Enter at least one field.',
        placement: 'topRight',
      });
      return;
    }
    setMut.mutate(cleaned);
  };

  const overallConfigured = status?.configured ?? false;

  return (
    <div style={{ maxWidth: 640 }}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Stored values are never sent back to this page. Enter a new value to rotate; leave a field
        blank to keep its current value.
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={onFinish}>
        {shape.fields.map((field) => {
          const fieldConfigured = status?.fields[field.name] ?? false;
          const placeholder = fieldConfigured
            ? `<set>${field.placeholder ? ` (placeholder: ${field.placeholder})` : ''}`
            : field.placeholder;
          return (
            <Form.Item key={field.name} label={field.label} name={field.name} extra={field.helper}>
              {field.secret ? (
                <Input.Password autoComplete="off" placeholder={placeholder} />
              ) : (
                <Input autoComplete="off" placeholder={placeholder} />
              )}
            </Form.Item>
          );
        })}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="primary" htmlType="submit" loading={setMut.isPending}>
            Save
          </Button>
          <Popconfirm
            title={`Disconnect ${shape.label}?`}
            description="All stored values for this platform are removed from config.yaml."
            okText="Disconnect"
            okButtonProps={{ danger: true }}
            onConfirm={() => clearMut.mutate()}
          >
            <Button danger disabled={!overallConfigured} loading={clearMut.isPending}>
              Disconnect
            </Button>
          </Popconfirm>
        </div>
      </Form>

      <AccessControlSection platform={shape.id} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Access control section (reusable per-platform)
// ---------------------------------------------------------------------------

const PLATFORM_HINTS: Record<string, string> = {
  telegram: 'Send /start to @userinfobot. The number shown is your user ID.',
  slack: 'Open your Slack profile → click the … menu → "Copy member ID".',
  discord: 'Enable Developer Mode → right-click your name → "Copy User ID".',
  email: "Use the sender's full email address (globs supported: *@example.com).",
  whatsapp: 'Your WhatsApp phone number in E.164 format (e.g., +14155551234).',
};

function AccessControlSection({ platform }: { platform: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [enabled, setEnabled] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState('');
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [newId, setNewId] = useState('');
  const [saved, setSaved] = useState(false);

  const filterQuery = useQuery({
    queryKey: ['platforms', 'channelFilter', platform],
    queryFn: () => rpc.platforms.getChannelFilter({ platform }),
  });

  useEffect(() => {
    if (filterQuery.data) {
      setEnabled(filterQuery.data.filter.enabled);
      setOwnerUserId(filterQuery.data.filter.ownerUserId);
      setAllowlist(filterQuery.data.filter.allowlist);
    }
  }, [filterQuery.data]);

  const saveMut = useMutation({
    mutationFn: () =>
      rpc.platforms.setChannelFilter({
        platform,
        filter: { enabled, ownerUserId, allowlist },
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['platforms', 'channelFilter', platform] });
      setEnabled(data.filter.enabled);
      setOwnerUserId(data.filter.ownerUserId);
      setAllowlist(data.filter.allowlist);
      setSaved(true);
      notification.success({ message: 'Access control saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const hint = PLATFORM_HINTS[platform] ?? '';

  const addId = () => {
    const trimmed = newId.trim();
    if (trimmed && !allowlist.includes(trimmed)) {
      setAllowlist([...allowlist, trimmed]);
    }
    setNewId('');
  };

  return (
    <>
      <Divider style={{ margin: '24px 0 16px' }} />
      <Card size="small" title="Access Control" style={{ maxWidth: 720 }}>
        {filterQuery.isLoading ? (
          <Spin />
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Switch checked={enabled} onChange={setEnabled} />
              <Typography.Text>Restrict to specific users</Typography.Text>
            </div>

            {enabled && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
                    Owner ID
                  </Typography.Text>
                  <Input
                    value={ownerUserId}
                    onChange={(e) => setOwnerUserId(e.target.value)}
                    placeholder="Owner user ID"
                    style={{ maxWidth: 400 }}
                  />
                  {hint && (
                    <Typography.Text
                      type="secondary"
                      style={{ display: 'block', marginTop: 4, fontSize: 12 }}
                    >
                      {hint}
                    </Typography.Text>
                  )}
                </div>

                <div style={{ marginBottom: 16 }}>
                  <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                    Additional users
                  </Typography.Text>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                    {allowlist.map((id) => (
                      <Tag
                        key={id}
                        closable
                        onClose={() => setAllowlist(allowlist.filter((x) => x !== id))}
                      >
                        {id}
                      </Tag>
                    ))}
                  </div>
                  <Space.Compact>
                    <Input
                      value={newId}
                      onChange={(e) => setNewId(e.target.value)}
                      onPressEnter={addId}
                      placeholder="Add user ID"
                      style={{ maxWidth: 300 }}
                    />
                    <Button onClick={addId}>Add</Button>
                  </Space.Compact>
                </div>
              </>
            )}

            <Button
              type="primary"
              style={{ marginTop: 16 }}
              loading={saveMut.isPending}
              onClick={() => saveMut.mutate()}
            >
              Save access control
            </Button>

            {saved && (
              <Alert
                type="info"
                showIcon
                message="Restart the gateway (or re-run `ethos serve`) to apply changes."
                style={{ marginTop: 16 }}
              />
            )}
          </>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Root Communications component — tab-per-platform layout
// ---------------------------------------------------------------------------

export function Communications() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as PlatformTabId | null;
  const activeTab =
    tabParam && PLATFORM_TABS.some((t) => t.id === tabParam) ? tabParam : 'telegram';

  const { data, isLoading, error } = useQuery({
    queryKey: ['platforms', 'list'],
    queryFn: () => rpc.platforms.list(),
  });

  const handleTabChange = (tab: PlatformTabId) => {
    setSearchParams({ tab });
  };

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load platforms: {(error as Error).message}
      </Typography.Text>
    );
  }

  const statusById = new Map((data?.platforms ?? []).map((p) => [p.id, p] as const));

  const renderTabContent = (tabId: PlatformTabId) => {
    const meta = PLATFORM_TABS.find((t) => t.id === tabId);
    if (!meta) return null;

    // Multi-bot platforms use their own panel when configured
    if (tabId === 'telegram') return <TelegramPanel />;
    if (tabId === 'slack') return <SlackPanel />;
    if (tabId === 'whatsapp') return <WhatsAppPanel />;

    // Legacy platforms (discord, email)
    const shape = LEGACY_PLATFORMS.find((s) => s.id === tabId);
    if (!shape) return null;
    const status = statusById.get(shape.id);

    if (!status?.configured) {
      return (
        <PlatformStub
          icon={meta.icon}
          name={meta.label}
          description={meta.description}
          onConnect={() => {
            /* Legacy panels handle their own inline form */
          }}
        />
      );
    }

    return <LegacyPlatformPanel shape={shape} status={status} />;
  };

  return (
    <div style={{ padding: '0 24px' }}>
      {/* Page header */}
      <div style={{ marginBottom: 4 }}>
        <h1
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-display)',
          }}
        >
          Platforms
        </h1>
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-secondary)',
            marginTop: 2,
          }}
        >
          Configure messaging channels
        </div>
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid var(--border-subtle)',
          marginBottom: 16,
        }}
      >
        {PLATFORM_TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabChange(tab.id)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--blue)' : '2px solid transparent',
                cursor: 'pointer',
                padding: '8px 16px',
                fontSize: 13,
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: isActive ? 500 : 400,
                fontFamily: 'var(--font-display)',
                transition: `color var(--motion-fast) var(--ease)`,
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div>{renderTabContent(activeTab)}</div>
    </div>
  );
}
