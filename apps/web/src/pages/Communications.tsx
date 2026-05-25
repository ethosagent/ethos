import type { BotBinding, SlackAppEntry, TelegramBotEntry } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Badge,
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
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
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
      title: 'Bot ID',
      dataIndex: 'botKey',
      key: 'botKey',
      render: (k: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {k}
        </Typography.Text>
      ),
    },
    {
      title: 'Token',
      key: 'token',
      render: (_: unknown, row: TelegramBotEntry) => (
        <Badge
          status={row.tokenConfigured ? 'success' : 'default'}
          text={row.tokenConfigured ? 'configured' : 'missing'}
        />
      ),
    },
    {
      title: 'Binding',
      key: 'bind',
      render: (_: unknown, row: TelegramBotEntry) => (
        <Space>
          <Tag color={row.bind.type === 'personality' ? 'blue' : 'purple'}>{row.bind.type}</Tag>
          <Typography.Text>{row.bind.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: unknown, row: TelegramBotEntry) => (
        <Popconfirm
          title="Remove this bot?"
          description="The bot token and binding will be deleted from config."
          okText="Remove"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeMut.mutate(row.botKey)}
        >
          <Button size="small" danger>
            Remove
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

  return (
    <Card
      size="small"
      title="Telegram bots"
      extra={
        <Typography.Link href="https://core.telegram.org/bots" target="_blank" rel="noreferrer">
          Setup guide ↗
        </Typography.Link>
      }
      style={{ maxWidth: 720 }}
    >
      {botsQuery.isLoading ? (
        <Spin />
      ) : (
        <Table
          dataSource={bots}
          columns={columns}
          rowKey="botKey"
          pagination={false}
          size="small"
          locale={{ emptyText: 'No bots configured yet.' }}
          style={{ marginBottom: bots.length > 0 ? 16 : 0 }}
        />
      )}

      {!adding && (
        <Button type="dashed" onClick={() => setAdding(true)} style={{ marginTop: 8 }}>
          + Add Telegram bot
        </Button>
      )}

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
    </Card>
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
      title: 'Bot ID',
      dataIndex: 'botKey',
      key: 'botKey',
      render: (k: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {k}
        </Typography.Text>
      ),
    },
    {
      title: 'Tokens',
      key: 'tokens',
      render: (_: unknown, row: SlackAppEntry) => (
        <Space size="small">
          <Badge status={row.botTokenConfigured ? 'success' : 'default'} text="bot" />
          <Badge status={row.appTokenConfigured ? 'success' : 'default'} text="app" />
          <Badge status={row.signingSecretConfigured ? 'success' : 'default'} text="secret" />
        </Space>
      ),
    },
    {
      title: 'Binding',
      key: 'bind',
      render: (_: unknown, row: SlackAppEntry) => (
        <Space>
          <Tag color={row.bind.type === 'personality' ? 'blue' : 'purple'}>{row.bind.type}</Tag>
          <Typography.Text>{row.bind.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: unknown, row: SlackAppEntry) => (
        <Popconfirm
          title="Remove this Slack app?"
          description="The app tokens and binding will be deleted from config."
          okText="Remove"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeMut.mutate(row.botKey)}
        >
          <Button size="small" danger>
            Remove
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

  return (
    <Card
      size="small"
      title="Slack apps"
      extra={
        <Typography.Link href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
          Setup guide ↗
        </Typography.Link>
      }
      style={{ maxWidth: 720 }}
    >
      {botsQuery.isLoading ? (
        <Spin />
      ) : (
        <Table
          dataSource={apps}
          columns={columns}
          rowKey="botKey"
          pagination={false}
          size="small"
          locale={{ emptyText: 'No Slack apps configured yet.' }}
          style={{ marginBottom: apps.length > 0 ? 16 : 0 }}
        />
      )}

      {!adding && (
        <Button type="dashed" onClick={() => setAdding(true)} style={{ marginTop: 8 }}>
          + Add Slack app
        </Button>
      )}

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
    </Card>
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
    <Card
      size="small"
      title={
        <span>
          {shape.label}{' '}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {overallConfigured ? '· connected' : '· not configured'}
          </Typography.Text>
        </span>
      }
      extra={
        shape.helpUrl ? (
          <Typography.Link href={shape.helpUrl} target="_blank" rel="noreferrer">
            Setup guide ↗
          </Typography.Link>
        ) : null
      }
      style={{ maxWidth: 640 }}
    >
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
    </Card>
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

                <Button type="primary" loading={saveMut.isPending} onClick={() => saveMut.mutate()}>
                  Save access control
                </Button>
              </>
            )}

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
// Root Communications component
// ---------------------------------------------------------------------------

export function Communications() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['platforms', 'list'],
    queryFn: () => rpc.platforms.list(),
  });

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

  return (
    <div className="comms-tab">
      <Tabs
        defaultActiveKey="telegram"
        items={[
          { key: 'telegram', label: 'Telegram', children: <TelegramPanel /> },
          { key: 'slack', label: 'Slack', children: <SlackPanel /> },
          ...LEGACY_PLATFORMS.map((shape) => {
            const status = statusById.get(shape.id);
            return {
              key: shape.id,
              label: (
                <span>
                  {shape.label}{' '}
                  <Badge
                    status={status?.configured ? 'success' : 'default'}
                    style={{ marginLeft: 6 }}
                  />
                </span>
              ),
              children: <LegacyPlatformPanel shape={shape} status={status} />,
            };
          }),
        ]}
      />
    </div>
  );
}
