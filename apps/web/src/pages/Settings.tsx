import { BUILTIN_SKIN_NAMES, BUILTIN_SKINS } from '@ethosagent/design-tokens';
import type { ApiKeyMetadata, ApiKeyScope, ProviderEntry } from '@ethosagent/web-contracts';
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { rpc } from '../rpc';

// Settings tab — read/write surface for ~/.ethos/config.yaml.
//
// Two visibility modes:
//   • Default   — provider, personality, memory mode.
//   • Advanced  — adds base URL, modelRouting record.
//
// The raw API key never crosses the wire on read; the server returns
// `apiKeyPreview` (e.g. `sk-…abc1`) so users can confirm "which key" is
// active. On update, the plaintext key is sent only when the user types
// a fresh value into the field.

// ---------------------------------------------------------------------------
// Provider chain row — local state for the editor
// ---------------------------------------------------------------------------

let nextRowId = 1;

interface ProviderRow {
  /** Stable key for React list rendering. */
  _id: number;
  provider: string;
  model: string;
  apiKey: string;
  apiKeyPreview: string;
  baseUrl: string;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
  testError?: string;
}

function emptyRow(): ProviderRow {
  return {
    _id: nextRowId++,
    provider: '',
    model: '',
    apiKey: '',
    apiKeyPreview: '',
    baseUrl: '',
    testStatus: 'idle',
  };
}

function rowsFromConfig(
  providers: ProviderEntry[],
  legacyProvider?: string,
  legacyModel?: string,
  legacyApiKeyPreview?: string,
  legacyBaseUrl?: string | null,
): ProviderRow[] {
  if (providers.length > 0) {
    return providers.map((p) => ({
      _id: nextRowId++,
      provider: p.provider,
      model: p.model ?? '',
      apiKey: '',
      apiKeyPreview: p.apiKeyPreview,
      baseUrl: p.baseUrl ?? '',
      testStatus: 'idle' as const,
    }));
  }
  // Backward compat: populate from single-field config
  if (legacyProvider) {
    return [
      {
        _id: nextRowId++,
        provider: legacyProvider,
        model: legacyModel ?? '',
        apiKey: '',
        apiKeyPreview: legacyApiKeyPreview ?? '',
        baseUrl: legacyBaseUrl ?? '',
        testStatus: 'idle' as const,
      },
    ];
  }
  return [emptyRow()];
}

// ---------------------------------------------------------------------------
// Inline test button for a single provider row
// ---------------------------------------------------------------------------

function RowTestButton({
  row,
  onStatusChange,
}: {
  row: ProviderRow;
  onStatusChange: (status: ProviderRow['testStatus'], error?: string) => void;
}) {
  const handleTest = async () => {
    if (!row.provider || !row.apiKey) return;
    onStatusChange('testing');
    try {
      const result = await rpc.onboarding.validateProvider({
        provider: row.provider as
          | 'anthropic'
          | 'openai'
          | 'openrouter'
          | 'openai-compat'
          | 'ollama'
          | 'azure',
        apiKey: row.apiKey,
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      });
      if (result.ok) {
        onStatusChange('success');
      } else {
        onStatusChange('error', result.error ?? 'Validation failed');
      }
    } catch (err) {
      onStatusChange('error', (err as Error).message);
    }
  };

  const hasKey = row.apiKey.length > 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Tooltip
        title={hasKey ? 'Test connection with the new API key' : 'Enter a new API key to test'}
      >
        <Button
          size="small"
          onClick={handleTest}
          loading={row.testStatus === 'testing'}
          disabled={!hasKey}
        >
          Test
        </Button>
      </Tooltip>
      {row.testStatus === 'success' && <Tag color="success">Connected</Tag>}
      {row.testStatus === 'error' && <Tag color="error">{row.testError ?? 'Failed'}</Tag>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form shape (no longer includes provider/model/apiKey/baseUrl — those live
// in the provider chain state)
// ---------------------------------------------------------------------------

interface FormShape {
  personality: string;
  memory: 'markdown' | 'vector';
  skin: string;
  approvalMode: 'manual' | 'smart' | 'off';
  verbosity: 'concise' | 'balanced' | 'verbose';
  debugMode: boolean;
  contextLayering: boolean;
}

export function Settings() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const navigate = useNavigate();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [form] = Form.useForm<FormShape>();
  const [providerRows, setProviderRows] = useState<ProviderRow[]>([emptyRow()]);
  const hydratedRef = useRef(false);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  // Hydrate form + provider rows whenever config data arrives or refreshes.
  useEffect(() => {
    if (configQuery.data) {
      form.setFieldsValue({
        personality: configQuery.data.personality,
        memory: configQuery.data.memory,
        skin: configQuery.data.skin,
        approvalMode: configQuery.data.approvalMode,
        verbosity: configQuery.data.verbosity,
        debugMode: configQuery.data.debugMode,
        contextLayering: configQuery.data.contextLayering,
      });
      // Only hydrate provider rows on first load or when data changes identity
      if (!hydratedRef.current) {
        setProviderRows(
          rowsFromConfig(
            configQuery.data.providers,
            configQuery.data.provider,
            configQuery.data.model,
            configQuery.data.apiKeyPreview,
            configQuery.data.baseUrl,
          ),
        );
        hydratedRef.current = true;
      }
    }
  }, [configQuery.data, form]);

  const updateRow = useCallback((index: number, patch: Partial<ProviderRow>) => {
    setProviderRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }, []);

  const moveRow = useCallback((index: number, direction: -1 | 1) => {
    setProviderRows((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      const a = next[index];
      const b = next[target];
      if (!a || !b) return prev;
      next[index] = b;
      next[target] = a;
      return next;
    });
  }, []);

  const removeRow = useCallback((index: number) => {
    setProviderRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addRow = useCallback(() => {
    setProviderRows((prev) => [...prev, emptyRow()]);
  }, []);

  const updateMut = useMutation({
    mutationFn: (patch: Parameters<typeof rpc.config.update>[0]) => rpc.config.update(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] });
      hydratedRef.current = false;
      notification.success({ message: 'Settings saved', placement: 'topRight' });
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
    const primary = providerRows[0];
    if (!primary?.provider || !primary.model) {
      notification.error({ message: 'Primary provider and model are required.' });
      return;
    }

    // Build the providers array for the update
    const providers = providerRows.map((row) => {
      const entry: { provider: string; model?: string; apiKey?: string; baseUrl?: string } = {
        provider: row.provider,
      };
      if (row.model) entry.model = row.model;
      if (row.apiKey) entry.apiKey = row.apiKey;
      if (row.baseUrl) entry.baseUrl = row.baseUrl;
      return entry;
    });

    const patch: Parameters<typeof rpc.config.update>[0] = {
      // Backward compat: also write the legacy single-provider fields from primary
      provider: primary.provider,
      model: primary.model,
      personality: values.personality,
      memory: values.memory,
      skin: values.skin,
      approvalMode: values.approvalMode,
      verbosity: values.verbosity,
      debugMode: values.debugMode,
      contextLayering: values.contextLayering,
      modelRouting: Object.fromEntries(
        Object.entries(configQuery.data?.modelRouting ?? {}).filter(
          ([k]) => k !== '__fallbackChain',
        ),
      ),
      providers,
    };
    if (primary.apiKey) patch.apiKey = primary.apiKey;
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
          {providerRows.map((row, idx) => {
            const label = idx === 0 ? 'Primary' : `Fallback ${idx}`;
            return (
              <div
                key={row._id}
                style={{
                  border: '1px solid var(--ethos-border, #d9d9d9)',
                  borderRadius: 6,
                  padding: 12,
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8,
                  }}
                >
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {label}
                  </Typography.Text>
                  <Space size={4}>
                    {idx > 0 && (
                      <Tooltip title="Move up">
                        <Button size="small" onClick={() => moveRow(idx, -1)}>
                          Up
                        </Button>
                      </Tooltip>
                    )}
                    {idx < providerRows.length - 1 && (
                      <Tooltip title="Move down">
                        <Button size="small" onClick={() => moveRow(idx, 1)}>
                          Down
                        </Button>
                      </Tooltip>
                    )}
                    {idx > 0 && (
                      <Tooltip title="Remove this fallback">
                        <Button size="small" danger onClick={() => removeRow(idx)}>
                          Remove
                        </Button>
                      </Tooltip>
                    )}
                  </Space>
                </div>

                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Provider
                    </Typography.Text>
                    <Input
                      size="small"
                      placeholder="anthropic | openrouter | openai-compat | ollama"
                      value={row.provider}
                      onChange={(e) => updateRow(idx, { provider: e.target.value })}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Model
                    </Typography.Text>
                    <Input
                      size="small"
                      placeholder="e.g. claude-opus-4-7"
                      value={row.model}
                      onChange={(e) => updateRow(idx, { model: e.target.value })}
                    />
                  </div>
                </div>

                <div style={{ marginBottom: 8 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    API key
                  </Typography.Text>
                  <Input.Password
                    size="small"
                    autoComplete="off"
                    placeholder={row.apiKeyPreview || 'paste new key'}
                    value={row.apiKey}
                    onChange={(e) => updateRow(idx, { apiKey: e.target.value, testStatus: 'idle' })}
                  />
                  {row.apiKeyPreview && !row.apiKey && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      Active: {row.apiKeyPreview}
                    </Typography.Text>
                  )}
                </div>

                {showAdvanced && (
                  <div style={{ marginBottom: 8 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Base URL
                    </Typography.Text>
                    <Input
                      size="small"
                      placeholder="https://openrouter.ai/api/v1"
                      value={row.baseUrl}
                      onChange={(e) => updateRow(idx, { baseUrl: e.target.value })}
                    />
                  </div>
                )}

                <RowTestButton
                  row={row}
                  onStatusChange={(status, error) =>
                    updateRow(idx, { testStatus: status, testError: error })
                  }
                />
              </div>
            );
          })}
          <Button type="dashed" size="small" onClick={addRow} style={{ width: '100%' }}>
            Add fallback
          </Button>
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

        <Card title="Approval mode" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Tool approval"
            name="approvalMode"
            extra="Controls whether the agent asks before running tools."
          >
            <Radio.Group>
              <Radio.Button value="manual">Always ask</Radio.Button>
              <Radio.Button value="smart">Auto-approve safe</Radio.Button>
              <Radio.Button value="off">Never ask</Radio.Button>
            </Radio.Group>
          </Form.Item>
        </Card>

        <Card title="Chat display" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Verbosity"
            name="verbosity"
            extra="How detailed the agent's responses should be."
          >
            <Select
              options={[
                { value: 'concise', label: 'Concise' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'verbose', label: 'Verbose' },
              ]}
            />
          </Form.Item>
        </Card>

        <Card title="Context" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            name="contextLayering"
            valuePropName="checked"
            extra="Include previous session summaries for deeper context across conversations."
          >
            <Checkbox>Enable context layering</Checkbox>
          </Form.Item>
        </Card>

        <Card title="Developer" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            name="debugMode"
            valuePropName="checked"
            extra="Show expanded tool arguments and internal events in chat."
          >
            <Checkbox>Enable debug mode</Checkbox>
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
  const entries = Object.entries(routing);
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
