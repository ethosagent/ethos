import { BUILTIN_SKIN_NAMES, BUILTIN_SKINS } from '@ethosagent/design-tokens';
import type { ApiKeyMetadata, ApiKeyScope, ProviderEntry } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MonoBadge } from '../components/ui/MonoBadge';
import { rpc } from '../rpc';

// Settings — single scrollable form redesign (09-settings.md).
//
// Two visibility modes:
//   Default   — provider chain, personality, memory mode, theme.
//   Advanced  — adds model routing table.
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
  editing: boolean;
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
    editing: true,
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
      editing: false,
    }));
  }
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
        editing: false,
      },
    ];
  }
  return [emptyRow()];
}

// ---------------------------------------------------------------------------
// Model routing state
// ---------------------------------------------------------------------------

interface RoutingOverride {
  _id: number;
  personality: string;
  model: string;
}

let nextRoutingId = 1;

function routingFromConfig(routing: Record<string, string>): RoutingOverride[] {
  return Object.entries(routing).map(([personality, model]) => ({
    _id: nextRoutingId++,
    personality,
    model,
  }));
}

// ---------------------------------------------------------------------------
// Form shape
// ---------------------------------------------------------------------------

interface FormShape {
  personality: string;
  memory: 'markdown' | 'vector';
  skin: string;
}

// ---------------------------------------------------------------------------
// Drag state helpers for HTML5 DnD
// ---------------------------------------------------------------------------

function useDragReorder<T>(_items: T[], setItems: React.Dispatch<React.SetStateAction<T[]>>) {
  const dragIdx = useRef<number | null>(null);

  const onDragStart = useCallback((idx: number) => {
    dragIdx.current = idx;
  }, []);

  const onDragOver = useCallback(
    (e: React.DragEvent, idx: number) => {
      e.preventDefault();
      const from = dragIdx.current;
      if (from === null || from === idx) return;
      setItems((prev) => {
        const next = [...prev];
        const dragged = next[from];
        if (!dragged) return prev;
        next.splice(from, 1);
        next.splice(idx, 0, dragged);
        dragIdx.current = idx;
        return next;
      });
    },
    [setItems],
  );

  const onDragEnd = useCallback(() => {
    dragIdx.current = null;
  }, []);

  return { onDragStart, onDragOver, onDragEnd };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Settings() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const navigate = useNavigate();
  const [showAdvanced, setShowAdvanced] = useState(() => {
    try {
      return localStorage.getItem('ethos:settings:advanced') === 'true';
    } catch {
      return false;
    }
  });
  const [form] = Form.useForm<FormShape>();
  const [providerRows, setProviderRows] = useState<ProviderRow[]>([emptyRow()]);
  const [routingOverrides, setRoutingOverrides] = useState<RoutingOverride[]>([]);
  const hydratedRef = useRef(false);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  // Persist advanced toggle
  const toggleAdvanced = useCallback(() => {
    setShowAdvanced((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('ethos:settings:advanced', String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // Hydrate form + provider rows whenever config data arrives or refreshes.
  useEffect(() => {
    if (configQuery.data) {
      form.setFieldsValue({
        personality: configQuery.data.personality,
        memory: configQuery.data.memory,
        skin: configQuery.data.skin,
      });
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
        const routing = configQuery.data.modelRouting ?? {};
        setRoutingOverrides(
          routingFromConfig(
            Object.fromEntries(Object.entries(routing).filter(([k]) => k !== '__fallbackChain')),
          ),
        );
        hydratedRef.current = true;
      }
    }
  }, [configQuery.data, form]);

  const updateRow = useCallback((index: number, patch: Partial<ProviderRow>) => {
    setProviderRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }, []);

  const removeRow = useCallback((index: number) => {
    setProviderRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addRow = useCallback(() => {
    setProviderRows((prev) => [...prev, emptyRow()]);
  }, []);

  const drag = useDragReorder(providerRows, setProviderRows);

  const handleTest = useCallback(
    async (row: ProviderRow, idx: number) => {
      if (!row.provider || !row.apiKey) return;
      updateRow(idx, { testStatus: 'testing' });
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
          updateRow(idx, { testStatus: 'success' });
        } else {
          updateRow(idx, {
            testStatus: 'error',
            testError: result.error ?? 'Validation failed',
          });
        }
      } catch (err) {
        updateRow(idx, { testStatus: 'error', testError: (err as Error).message });
      }
    },
    [updateRow],
  );

  // Routing overrides
  const updateRouting = useCallback((index: number, patch: Partial<RoutingOverride>) => {
    setRoutingOverrides((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }, []);

  const removeRouting = useCallback((index: number) => {
    setRoutingOverrides((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addRouting = useCallback(() => {
    setRoutingOverrides((prev) => [...prev, { _id: nextRoutingId++, personality: '', model: '' }]);
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

    const providers = providerRows.map((row) => {
      const entry: { provider: string; model?: string; apiKey?: string; baseUrl?: string } = {
        provider: row.provider,
      };
      if (row.model) entry.model = row.model;
      if (row.apiKey) entry.apiKey = row.apiKey;
      if (row.baseUrl) entry.baseUrl = row.baseUrl;
      return entry;
    });

    const modelRouting: Record<string, string> = {};
    for (const override of routingOverrides) {
      if (override.personality && override.model) {
        modelRouting[override.personality] = override.model;
      }
    }

    const patch: Parameters<typeof rpc.config.update>[0] = {
      provider: primary.provider,
      model: primary.model,
      personality: values.personality,
      memory: values.memory,
      skin: values.skin,
      modelRouting,
      providers,
    };
    if (primary.apiKey) patch.apiKey = primary.apiKey;
    if (primary.baseUrl !== undefined) patch.baseUrl = primary.baseUrl;

    updateMut.mutate(patch);
  };

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h2 className="settings-title">Settings</h2>
        <button type="button" className="settings-advanced-btn" onClick={toggleAdvanced}>
          {showAdvanced ? 'Hide advanced' : 'Show advanced'}
          <span
            className="settings-advanced-chevron"
            style={{ transform: showAdvanced ? 'rotate(180deg)' : 'rotate(0deg)' }}
          >
            ▾
          </span>
        </button>
      </header>

      <Form<FormShape> form={form} layout="vertical" onFinish={onFinish}>
        {/* ── Provider Chain ───────────────────────────────────────── */}
        <div className="settings-section">
          <span className="settings-section-label">Provider chain</span>
          <div className="settings-provider-list">
            {providerRows.map((row, idx) => (
              // biome-ignore lint/a11y/noStaticElementInteractions: drag-reorderable row uses HTML5 DnD
              <div
                key={row._id}
                className="settings-provider-row"
                draggable
                onDragStart={() => drag.onDragStart(idx)}
                onDragOver={(e) => drag.onDragOver(e, idx)}
                onDragEnd={drag.onDragEnd}
              >
                <span className="settings-drag-handle" title="Drag to reorder">
                  ⠿
                </span>
                <span className="settings-provider-name">{row.provider || '—'}</span>
                <span className="settings-provider-model">{row.model || '—'}</span>
                <span className="settings-provider-key">
                  {row.apiKeyPreview || (row.apiKey ? '••••' : '—')}
                </span>
                {idx === 0 ? (
                  <MonoBadge label="✓ active" variant="green" />
                ) : (
                  <MonoBadge label="standby" variant="dim" />
                )}
                <span className="settings-provider-actions">
                  <button
                    type="button"
                    className="btn-ghost settings-action-btn"
                    disabled={!row.apiKey}
                    onClick={() => handleTest(row, idx)}
                  >
                    {row.testStatus === 'testing' ? '...' : 'Test'}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost settings-action-btn"
                    onClick={() => updateRow(idx, { editing: !row.editing })}
                  >
                    {row.editing ? 'Done' : 'Edit'}
                  </button>
                  {providerRows.length > 1 && (
                    <button
                      type="button"
                      className="settings-action-btn settings-action-remove"
                      onClick={() => removeRow(idx)}
                    >
                      ×
                    </button>
                  )}
                </span>
                {row.testStatus === 'success' && (
                  <span className="settings-test-result" style={{ color: 'var(--green)' }}>
                    Connected
                  </span>
                )}
                {row.testStatus === 'error' && (
                  <span className="settings-test-result" style={{ color: 'var(--red)' }}>
                    {row.testError ?? 'Failed'}
                  </span>
                )}

                {row.editing && (
                  <div className="settings-provider-edit">
                    <div className="settings-provider-edit-row">
                      <span className="settings-field-label">Provider</span>
                      <input
                        className="input settings-field-input"
                        placeholder="anthropic | openrouter | openai-compat | ollama"
                        value={row.provider}
                        onChange={(e) => updateRow(idx, { provider: e.target.value })}
                      />
                    </div>
                    <div className="settings-provider-edit-row">
                      <span className="settings-field-label">Model</span>
                      <input
                        className="input input-mono settings-field-input"
                        placeholder="e.g. claude-opus-4-7"
                        value={row.model}
                        onChange={(e) => updateRow(idx, { model: e.target.value })}
                      />
                    </div>
                    <div className="settings-provider-edit-row">
                      <span className="settings-field-label">API Key</span>
                      <input
                        type="password"
                        className="input input-mono settings-field-input"
                        autoComplete="off"
                        placeholder={row.apiKeyPreview || 'paste new key'}
                        value={row.apiKey}
                        onChange={(e) =>
                          updateRow(idx, { apiKey: e.target.value, testStatus: 'idle' })
                        }
                      />
                    </div>
                    {showAdvanced && (
                      <div className="settings-provider-edit-row">
                        <span className="settings-field-label">Base URL</span>
                        <input
                          className="input input-mono settings-field-input"
                          placeholder="https://openrouter.ai/api/v1"
                          value={row.baseUrl}
                          onChange={(e) => updateRow(idx, { baseUrl: e.target.value })}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button type="button" className="settings-add-provider" onClick={addRow}>
            ＋ Add provider
          </button>
        </div>

        {/* ── Default Personality ──────────────────────────────────── */}
        <div className="settings-inline-row">
          <span className="settings-row-label">Default personality</span>
          <Form.Item
            name="personality"
            rules={[{ required: true, message: 'Required' }]}
            style={{ margin: 0 }}
          >
            <select className="settings-select">
              {personalities.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.builtin ? ' (built-in)' : ''}
                </option>
              ))}
            </select>
          </Form.Item>
        </div>

        {/* ── Memory Mode ─────────────────────────────────────────── */}
        <div className="settings-inline-row">
          <span className="settings-row-label">Memory mode</span>
          <Form.Item name="memory" style={{ margin: 0 }}>
            <MemoryRadioGroup />
          </Form.Item>
        </div>

        {/* ── Theme ───────────────────────────────────────────────── */}
        <div className="settings-inline-row">
          <span className="settings-row-label">Theme</span>
          <Form.Item name="skin" style={{ margin: 0 }}>
            <select className="settings-select">
              {BUILTIN_SKIN_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name} — {BUILTIN_SKINS[name].description}
                </option>
              ))}
            </select>
          </Form.Item>
        </div>

        {/* ── Advanced ────────────────────────────────────────────── */}
        {showAdvanced && (
          <div className="settings-section" style={{ marginTop: 24 }}>
            <span className="settings-section-label">Advanced</span>
            <div className="settings-routing-table">
              <div className="settings-routing-header">
                <span className="settings-routing-col" style={{ flex: 1 }}>
                  Personality
                </span>
                <span className="settings-routing-col" style={{ width: 200 }}>
                  Model Override
                </span>
                <span className="settings-routing-col" style={{ width: 40 }} />
              </div>
              {routingOverrides.map((override, idx) => (
                <div key={override._id} className="settings-routing-row">
                  <input
                    className="input settings-routing-input"
                    style={{ flex: 1 }}
                    placeholder="personality id"
                    value={override.personality}
                    onChange={(e) => updateRouting(idx, { personality: e.target.value })}
                  />
                  <input
                    className="input input-mono settings-routing-input"
                    style={{ width: 200 }}
                    placeholder="model override"
                    value={override.model}
                    onChange={(e) => updateRouting(idx, { model: e.target.value })}
                  />
                  <button
                    type="button"
                    className="settings-action-btn settings-action-remove"
                    onClick={() => removeRouting(idx)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {routingOverrides.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 0' }}>
                  No per-personality overrides set.
                </div>
              )}
            </div>
            <button type="button" className="settings-add-provider" onClick={addRouting}>
              ＋ Add override
            </button>
          </div>
        )}

        {/* ── Save ────────────────────────────────────────────────── */}
        <div className="settings-save-row">
          <button
            type="submit"
            className="btn btn-blue settings-save-btn"
            disabled={updateMut.isPending}
          >
            {updateMut.isPending ? 'Saving...' : 'Save settings'}
          </button>
        </div>
      </Form>

      {/* ── Setup wizard link ──────────────────────────────────────── */}
      <div className="settings-section" style={{ marginTop: 32 }}>
        <span className="settings-section-label">Setup</span>
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 8px' }}>
            Re-run the guided setup to change your provider, model, personality, or messaging
            credentials.
          </p>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/onboarding')}>
            Run setup wizard
          </button>
        </div>
      </div>

      <ApiKeysSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory radio group — styled as ghost-bordered toggle buttons
// ---------------------------------------------------------------------------

function MemoryRadioGroup({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (val: string) => void;
}) {
  const options = ['markdown', 'vector'] as const;
  return (
    <div className="settings-radio-group">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={`settings-radio-btn ${value === opt ? 'settings-radio-btn--active' : ''}`}
          onClick={() => onChange?.(opt)}
        >
          {opt.charAt(0).toUpperCase() + opt.slice(1)}
        </button>
      ))}
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
        <span className="settings-section-label">API Keys</span>
        <Button type="primary" size="small" onClick={() => setCreateOpen(true)}>
          Create API Key
        </Button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
        Bearer tokens for external Mission Controls. Each key is scoped to specific operations and
        origins.
      </p>

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
