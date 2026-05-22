import { BUILTIN_SKIN_NAMES, BUILTIN_SKINS } from '@ethosagent/design-tokens';
import type { ApiKeyMetadata, ApiKeyScope } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { rpc } from '../rpc';

// Settings tab — read/write surface for ~/.ethos/config.yaml.
//
// Two visibility modes:
//   • Default   — provider chain, personality, memory mode.
//   • Advanced  — adds base URL per provider, modelRouting record.
//
// The raw API key never crosses the wire on read; the server returns
// `apiKeyPreview` (e.g. `sk-…abc1`) so users can confirm "which key" is
// active. On update, the plaintext key is sent only when the user types
// a fresh value into the field.

// ---------------------------------------------------------------------------
// Provider Chain Editor types
// ---------------------------------------------------------------------------

interface ProviderEntry {
  id: string;
  provider: string;
  model: string;
  apiKey: string;
  apiKeyPreview: string;
  baseUrl: string;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
  testError?: string;
}

const FALLBACK_CHAIN_KEY = '__fallbackChain';

let nextEntryId = 0;
function makeEntryId(): string {
  nextEntryId += 1;
  return `pe_${Date.now()}_${nextEntryId}`;
}

function emptyEntry(): ProviderEntry {
  return {
    id: makeEntryId(),
    provider: '',
    model: '',
    apiKey: '',
    apiKeyPreview: '',
    baseUrl: '',
    testStatus: 'idle',
  };
}

/** Parse fallback chain from modelRouting.__fallbackChain JSON string. */
function parseFallbackChain(routing: Record<string, string>): ProviderEntry[] {
  const raw = routing[FALLBACK_CHAIN_KEY];
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((entry: Record<string, string>) => ({
      id: makeEntryId(),
      provider: entry.provider ?? '',
      model: entry.model ?? '',
      apiKey: '',
      apiKeyPreview: entry.apiKeyPreview ?? '',
      baseUrl: entry.baseUrl ?? '',
      testStatus: 'idle' as const,
    }));
  } catch {
    return [];
  }
}

/** Serialize fallback entries (excluding primary) to a JSON string for modelRouting. */
function serializeFallbackChain(
  entries: ProviderEntry[],
): { provider: string; model: string; apiKeyPreview: string; baseUrl?: string }[] {
  return entries.map((e) => ({
    provider: e.provider,
    model: e.model,
    apiKeyPreview: e.apiKeyPreview,
    ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Provider Chain Editor component
// ---------------------------------------------------------------------------

function ProviderChainEditor({
  chain,
  onChange,
  showAdvanced,
}: {
  chain: ProviderEntry[];
  onChange: (chain: ProviderEntry[]) => void;
  showAdvanced: boolean;
}) {
  const updateEntry = useCallback(
    (id: string, patch: Partial<ProviderEntry>) => {
      onChange(chain.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    },
    [chain, onChange],
  );

  const removeEntry = useCallback(
    (id: string) => {
      onChange(chain.filter((e) => e.id !== id));
    },
    [chain, onChange],
  );

  const moveEntry = useCallback(
    (index: number, direction: 'up' | 'down') => {
      const target = direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= chain.length) return;
      const next = [...chain];
      const temp = next[index];
      next[index] = next[target];
      next[target] = temp;
      onChange(next);
    },
    [chain, onChange],
  );

  const addFallback = useCallback(() => {
    onChange([...chain, emptyEntry()]);
  }, [chain, onChange]);

  const testConnection = useCallback(
    async (id: string) => {
      const entry = chain.find((e) => e.id === id);
      if (!entry?.provider) return;
      updateEntry(id, { testStatus: 'testing', testError: undefined });
      try {
        const result = await rpc.onboarding.validateProvider({
          provider: entry.provider as
            | 'anthropic'
            | 'openai'
            | 'openrouter'
            | 'openai-compat'
            | 'ollama'
            | 'azure',
          apiKey: entry.apiKey || 'existing-key',
          ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
        });
        if (result.ok) {
          updateEntry(id, { testStatus: 'success' });
        } else {
          updateEntry(id, { testStatus: 'error', testError: result.error ?? 'Validation failed' });
        }
      } catch (err) {
        updateEntry(id, { testStatus: 'error', testError: (err as Error).message });
      }
    },
    [chain, updateEntry],
  );

  return (
    <div className="provider-chain">
      {/* Chain diagram — always visible */}
      {chain.length > 0 && (
        <div className="provider-chain-diagram">
          {chain.map((entry, i) => (
            <span key={entry.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <span className="provider-chain-diagram-pill">
                {entry.provider || 'unset'}
                {entry.model ? ` / ${entry.model}` : ''}
              </span>
              {i < chain.length - 1 && <span className="provider-chain-diagram-arrow">{'→'}</span>}
            </span>
          ))}
        </div>
      )}

      {/* Provider rows */}
      {chain.map((entry, index) => (
        <div
          key={entry.id}
          className={`provider-chain-row${index === 0 ? ' provider-chain-row-primary' : ''}`}
        >
          <div className="provider-chain-row-header">
            <Typography.Text strong style={{ fontSize: 13 }}>
              {index === 0 ? 'Primary' : `Fallback ${index}`}
            </Typography.Text>
            <div className="provider-chain-row-actions">
              <Tooltip title="Move up">
                <Button size="small" disabled={index === 0} onClick={() => moveEntry(index, 'up')}>
                  {'↑'}
                </Button>
              </Tooltip>
              <Tooltip title="Move down">
                <Button
                  size="small"
                  disabled={index === chain.length - 1}
                  onClick={() => moveEntry(index, 'down')}
                >
                  {'↓'}
                </Button>
              </Tooltip>
              <Button
                size="small"
                onClick={() => testConnection(entry.id)}
                loading={entry.testStatus === 'testing'}
              >
                Test
              </Button>
              {index > 0 && (
                <Button size="small" danger onClick={() => removeEntry(entry.id)}>
                  Remove
                </Button>
              )}
            </div>
          </div>

          <div className="provider-chain-row-fields">
            <div>
              <span className="provider-chain-field-label">Provider</span>
              <Input
                size="small"
                placeholder="anthropic | openrouter | openai-compat | ollama"
                value={entry.provider}
                onChange={(e) => updateEntry(entry.id, { provider: e.target.value })}
              />
            </div>
            <div>
              <span className="provider-chain-field-label">Model</span>
              <Input
                size="small"
                placeholder="e.g. claude-opus-4-7"
                value={entry.model}
                onChange={(e) => updateEntry(entry.id, { model: e.target.value })}
              />
            </div>
            <div>
              <span className="provider-chain-field-label">API key</span>
              <Input.Password
                size="small"
                autoComplete="off"
                placeholder={entry.apiKeyPreview || 'paste new key'}
                value={entry.apiKey}
                onChange={(e) => updateEntry(entry.id, { apiKey: e.target.value })}
              />
              {entry.apiKeyPreview && !entry.apiKey && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  Active: {entry.apiKeyPreview}
                </Typography.Text>
              )}
            </div>
            {showAdvanced && (
              <div>
                <span className="provider-chain-field-label">Base URL</span>
                <Input
                  size="small"
                  placeholder="https://openrouter.ai/api/v1"
                  value={entry.baseUrl}
                  onChange={(e) => updateEntry(entry.id, { baseUrl: e.target.value })}
                />
              </div>
            )}
          </div>

          {/* Test result */}
          <div className="provider-chain-test-result">
            {entry.testStatus === 'success' && <Tag color="success">Connected</Tag>}
            {entry.testStatus === 'error' && (
              <Tag color="error">{entry.testError ?? 'Connection failed'}</Tag>
            )}
          </div>
        </div>
      ))}

      <Button type="dashed" className="provider-chain-add" onClick={addFallback}>
        + Add fallback provider
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form shape (non-chain fields)
// ---------------------------------------------------------------------------

interface FormShape {
  personality: string;
  memory: 'markdown' | 'vector';
  skin: string;
}

export function Settings() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const navigate = useNavigate();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [form] = Form.useForm<FormShape>();
  const [providerChain, setProviderChain] = useState<ProviderEntry[]>([]);
  const [chainInitialized, setChainInitialized] = useState(false);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  // Hydrate form + provider chain once config arrives.
  useEffect(() => {
    if (configQuery.data && !chainInitialized) {
      form.setFieldsValue({
        personality: configQuery.data.personality,
        memory: configQuery.data.memory,
        skin: configQuery.data.skin,
      });

      // Build the chain: primary from top-level fields, fallbacks from modelRouting.
      const primary: ProviderEntry = {
        id: makeEntryId(),
        provider: configQuery.data.provider,
        model: configQuery.data.model,
        apiKey: '',
        apiKeyPreview: configQuery.data.apiKeyPreview,
        baseUrl: configQuery.data.baseUrl ?? '',
        testStatus: 'idle',
      };
      const fallbacks = parseFallbackChain(configQuery.data.modelRouting ?? {});
      setProviderChain([primary, ...fallbacks]);
      setChainInitialized(true);
    }
  }, [configQuery.data, form, chainInitialized]);

  const updateMut = useMutation({
    mutationFn: (patch: Parameters<typeof rpc.config.update>[0]) => rpc.config.update(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] });
      notification.success({ message: 'Settings saved', placement: 'topRight' });
      // Clear apiKey fields in the chain after save.
      setProviderChain((prev) => prev.map((e) => ({ ...e, apiKey: '' })));
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  if (configQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (configQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load config: {(configQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const personalities = personalitiesQuery.data?.items ?? [];

  const onFinish = (values: FormShape) => {
    const primary = providerChain[0];
    if (!primary?.provider || !primary.model) {
      notification.error({ message: 'Primary provider and model are required.' });
      return;
    }

    // Build the existing modelRouting, excluding our fallback key.
    const existingRouting = { ...(configQuery.data?.modelRouting ?? {}) };
    delete existingRouting[FALLBACK_CHAIN_KEY];

    // Serialize fallbacks into modelRouting.
    const fallbacks = providerChain.slice(1);
    const modelRouting: Record<string, string> = { ...existingRouting };
    if (fallbacks.length > 0) {
      modelRouting[FALLBACK_CHAIN_KEY] = JSON.stringify(serializeFallbackChain(fallbacks));
    }

    const patch: Parameters<typeof rpc.config.update>[0] = {
      provider: primary.provider,
      model: primary.model,
      personality: values.personality,
      memory: values.memory,
      skin: values.skin,
      modelRouting,
    };
    if (primary.apiKey && primary.apiKey.length > 0) patch.apiKey = primary.apiKey;
    if (primary.baseUrl !== undefined) patch.baseUrl = primary.baseUrl;

    updateMut.mutate(patch);
  };

  return (
    <div className="settings-tab">
      <header className="settings-toolbar">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Settings
        </Typography.Title>
        <span className="settings-advanced-toggle">
          <span className="settings-advanced-label">Show advanced</span>
          <Switch checked={showAdvanced} onChange={setShowAdvanced} />
        </span>
      </header>

      <Form<FormShape> form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 640 }}>
        <Card title="Provider chain" size="small" style={{ marginBottom: 16 }}>
          <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 12 }}>
            Primary provider is tried first. Fallbacks are used in order if the primary fails.
          </Typography.Paragraph>
          <ProviderChainEditor
            chain={providerChain}
            onChange={setProviderChain}
            showAdvanced={showAdvanced}
          />
        </Card>

        <Card title="Default personality" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Personality"
            name="personality"
            rules={[{ required: true, message: 'Required' }]}
            extra="Used when chat doesn't override per-session."
          >
            <Select
              loading={personalitiesQuery.isLoading}
              options={personalities.map((p) => ({
                label: `${p.name}${p.builtin ? ' (built-in)' : ''}`,
                value: p.id,
              }))}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
        </Card>

        <Card title="Appearance" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Skin"
            name="skin"
            extra="DESIGN.md baseline plus named overrides. Applies across all surfaces (Web, TUI)."
          >
            <Select
              options={BUILTIN_SKIN_NAMES.map((name) => ({
                value: name,
                label: `${name} — ${BUILTIN_SKINS[name].description}`,
              }))}
            />
          </Form.Item>
        </Card>

        <Card title="Memory" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Memory mode"
            name="memory"
            extra="Markdown is human-editable in ~/.ethos/MEMORY.md. Vector uses local embeddings."
          >
            <Radio.Group>
              <Radio.Button value="markdown">Markdown</Radio.Button>
              <Radio.Button value="vector">Vector</Radio.Button>
            </Radio.Group>
          </Form.Item>
        </Card>

        {showAdvanced ? (
          <Card title="Model routing" size="small" style={{ marginBottom: 16 }}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              Per-personality model overrides. Edit ~/.ethos/config.yaml directly to add entries —
              this surface lists the current overrides; full editing lands later.
            </Typography.Paragraph>
            <ModelRoutingView routing={configQuery.data?.modelRouting ?? {}} />
          </Card>
        ) : null}

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={updateMut.isPending}>
            Save
          </Button>
        </Form.Item>
      </Form>

      <Card title="Setup wizard" size="small" style={{ maxWidth: 640, marginTop: 8 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 12 }}>
          Re-run the guided setup to change your provider, model, personality, or messaging
          credentials.
        </Typography.Paragraph>
        <Button onClick={() => navigate('/onboarding')}>Run setup wizard</Button>
      </Card>

      <ApiKeysSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// API Keys management section
// ---------------------------------------------------------------------------

const ALL_SCOPES: ApiKeyScope[] = [
  'sessions:read',
  'sessions:write',
  'chat:send',
  'personalities:read',
  'memory:read',
  'memory:write',
  'tools:approve',
  'events:subscribe',
];

interface CreateKeyForm {
  name: string;
  scopes: ApiKeyScope[];
  origins: string[];
}

function ApiKeysSection() {
  const qc = useQueryClient();
  const { notification, modal } = AntApp.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [form] = Form.useForm<CreateKeyForm>();

  const keysQuery = useQuery({
    queryKey: ['apiKeys'],
    queryFn: () => rpc.apiKeys.list({}),
  });

  const createMut = useMutation({
    mutationFn: (input: { name: string; scopes: ApiKeyScope[]; allowedOrigins: string[] }) =>
      rpc.apiKeys.create(input),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['apiKeys'] });
      setCreateOpen(false);
      form.resetFields();
      setRevealedSecret(data.secret);
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to create API key',
        description: (err as Error).message,
      }),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => rpc.apiKeys.revoke({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apiKeys'] });
      notification.success({ message: 'API key revoked', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to revoke API key',
        description: (err as Error).message,
      }),
  });

  const handleRevoke = (id: string, name: string) => {
    modal.confirm({
      title: 'Revoke API key',
      content: `Revoke "${name}"? External Mission Controls using this key will lose access immediately.`,
      okText: 'Revoke',
      okButtonProps: { danger: true },
      onOk: () => revokeMut.mutate(id),
    });
  };

  const handleCreate = (values: CreateKeyForm) => {
    createMut.mutate({
      name: values.name,
      scopes: values.scopes,
      allowedOrigins: values.origins.filter((o) => o.trim().length > 0),
    });
  };

  const copySecret = async () => {
    if (!revealedSecret) return;
    try {
      await navigator.clipboard.writeText(revealedSecret);
      notification.success({ message: 'Copied to clipboard', placement: 'topRight' });
    } catch {
      notification.error({ message: 'Copy failed — select and copy manually' });
    }
  };

  const columns: ColumnsType<ApiKeyMetadata> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: 'Prefix',
      dataIndex: 'prefix',
      key: 'prefix',
      render: (prefix: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {prefix}
        </Typography.Text>
      ),
    },
    {
      title: 'Scopes',
      dataIndex: 'scopes',
      key: 'scopes',
      render: (scopes: ApiKeyScope[]) => (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {scopes.map((s) => (
            <Tag key={s} style={{ margin: 0, fontSize: 11 }}>
              {s}
            </Tag>
          ))}
        </span>
      ),
    },
    {
      title: 'Allowed Origins',
      dataIndex: 'allowedOrigins',
      key: 'allowedOrigins',
      render: (origins: string[]) =>
        origins.length > 0 ? (
          <Tooltip title={origins.join(', ')}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {origins.length} origin{origins.length !== 1 ? 's' : ''}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            none
          </Typography.Text>
        ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => (
        <Typography.Text style={{ fontSize: 12 }}>
          {new Date(v).toLocaleDateString()}
        </Typography.Text>
      ),
    },
    {
      title: 'Last Used',
      dataIndex: 'lastUsed',
      key: 'lastUsed',
      render: (v: string | null) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {v ? new Date(v).toLocaleDateString() : 'never'}
        </Typography.Text>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      render: (_: unknown, record: ApiKeyMetadata) =>
        record.revokedAt ? <Tag color="default">Revoked</Tag> : <Tag color="green">Active</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, record: ApiKeyMetadata) =>
        record.revokedAt ? null : (
          <Button
            size="small"
            danger
            onClick={() => handleRevoke(record.id, record.name)}
            loading={revokeMut.isPending}
          >
            Revoke
          </Button>
        ),
    },
  ];

  const keys = keysQuery.data?.items ?? [];

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          API Keys
        </Typography.Title>
        <Button type="primary" size="small" onClick={() => setCreateOpen(true)}>
          Create API Key
        </Button>
      </div>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 16 }}>
        Bearer tokens for external Mission Controls. Each key is scoped to specific operations and
        origins.
      </Typography.Paragraph>

      <Table<ApiKeyMetadata>
        columns={columns}
        dataSource={keys}
        rowKey="id"
        size="small"
        loading={keysQuery.isLoading}
        pagination={false}
        locale={{ emptyText: 'No API keys created yet.' }}
        rowClassName={(record) => (record.revokedAt ? 'api-key-revoked' : '')}
        scroll={{ x: true }}
      />

      {/* Create modal */}
      <Modal
        title="Create API Key"
        open={createOpen}
        onCancel={() => {
          setCreateOpen(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        confirmLoading={createMut.isPending}
        okText="Create"
        destroyOnClose
      >
        <Form<CreateKeyForm>
          form={form}
          layout="vertical"
          onFinish={handleCreate}
          initialValues={{ origins: [''] }}
        >
          <Form.Item
            label="Name"
            name="name"
            rules={[
              { required: true, message: 'Name is required' },
              { max: 100, message: 'Max 100 characters' },
            ]}
          >
            <Input placeholder="e.g. Production frontend" />
          </Form.Item>

          <Form.Item
            label="Scopes"
            name="scopes"
            rules={[{ required: true, message: 'Select at least one scope' }]}
          >
            <Checkbox.Group
              options={ALL_SCOPES.map((s) => ({ label: s, value: s }))}
              style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            />
          </Form.Item>

          <Form.Item label="Allowed Origins">
            <Form.List
              name="origins"
              rules={[
                {
                  validator: async (_, origins: string[]) => {
                    const filled = (origins ?? []).filter((o) => o.trim().length > 0);
                    if (filled.length === 0) {
                      throw new Error('At least one origin is required');
                    }
                  },
                },
              ]}
            >
              {(fields, { add, remove }, { errors }) => (
                <>
                  {fields.map((field) => (
                    <Space
                      key={field.key}
                      align="start"
                      style={{ display: 'flex', marginBottom: 8 }}
                    >
                      <Form.Item
                        {...field}
                        validateTrigger={['onChange', 'onBlur']}
                        rules={[
                          {
                            validator: async (_, value: string) => {
                              if (!value || value.trim().length === 0) return;
                              try {
                                const u = new URL(value);
                                if (u.origin !== value) {
                                  throw new Error(
                                    'Must be a valid origin (scheme + host, no path)',
                                  );
                                }
                              } catch {
                                throw new Error(
                                  'Must be a valid origin (e.g. https://example.com)',
                                );
                              }
                            },
                          },
                        ]}
                        noStyle
                      >
                        <Input placeholder="https://example.com" style={{ width: 300 }} />
                      </Form.Item>
                      {fields.length > 1 ? (
                        <Button size="small" onClick={() => remove(field.name)}>
                          Remove
                        </Button>
                      ) : null}
                    </Space>
                  ))}
                  <Form.Item>
                    <Button type="dashed" onClick={() => add('')} style={{ width: 300 }}>
                      Add origin
                    </Button>
                    <Form.ErrorList errors={errors} />
                  </Form.Item>
                </>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>

      {/* Secret reveal modal */}
      <Modal
        title="Copy your API key"
        open={revealedSecret !== null}
        onCancel={() => setRevealedSecret(null)}
        footer={[
          <Button key="copy" type="primary" onClick={copySecret}>
            Copy to clipboard
          </Button>,
          <Button key="close" onClick={() => setRevealedSecret(null)}>
            Done
          </Button>,
        ]}
        closable
      >
        <Typography.Paragraph type="warning" style={{ marginBottom: 12 }}>
          This secret will not be shown again. Copy it now and store it securely.
        </Typography.Paragraph>
        <Input.TextArea
          value={revealedSecret ?? ''}
          readOnly
          autoSize
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 13 }}
        />
      </Modal>

      <style>{`
        .api-key-revoked {
          opacity: 0.5;
        }
      `}</style>
    </div>
  );
}

function ModelRoutingView({ routing }: { routing: Record<string, string> }) {
  // Filter out internal keys used by the provider chain editor.
  const entries = Object.entries(routing).filter(([key]) => key !== FALLBACK_CHAIN_KEY);
  if (entries.length === 0) {
    return <Typography.Text type="secondary">No per-personality overrides set.</Typography.Text>;
  }
  return (
    <ul style={{ margin: 0, paddingLeft: 16 }}>
      {entries.map(([personality, model]) => (
        <li key={personality} style={{ fontSize: 13, color: 'var(--ethos-text)' }}>
          <Typography.Text code>{personality}</Typography.Text>
          {' → '}
          <Typography.Text code>{model}</Typography.Text>
        </li>
      ))}
    </ul>
  );
}
