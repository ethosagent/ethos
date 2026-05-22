import type {
  McpPolicy,
  McpServerInfo,
  Personality,
  PersonalitySkill,
  PluginInfo,
  ProviderId,
} from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { rpc } from '../rpc';

// Personalities tab — v1.
//
// List of all personalities (built-in + user-created) with three
// row-level actions:
//   • Edit       — opens a 3-tab modal (Identity / Toolset / Config).
//                  Skills sub-surface lives there too. Built-ins are
//                  read-only here; the action becomes "Duplicate."
//   • Duplicate  — copies the personality into ~/.ethos/personalities/
//                  under a new id, opens the editor on the copy.
//   • Delete     — only for user-created personalities.
//
// Plus a "New personality" button at the top → tabbed create wizard.
//
// Live preview chat (plan: side-pane disposable session) is deferred
// to v1.x — the chat plumbing has assumptions about persistent
// session state that need a wider refactor to disposable mode.

export function Personalities() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState<Personality | null>(null);

  const listQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  if (listQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (listQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load personalities: {(listQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const personalities = listQuery.data?.items ?? [];
  const defaultId = listQuery.data?.defaultId ?? null;

  return (
    <div className="personalities-tab">
      <header className="personalities-toolbar">
        <span className="personalities-count">
          {personalities.length} {personalities.length === 1 ? 'personality' : 'personalities'}
        </span>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          New personality
        </Button>
      </header>

      <Table<Personality>
        rowKey="id"
        dataSource={personalities}
        pagination={false}
        size="small"
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No personalities loaded. Run `ethos setup` first."
            />
          ),
        }}
        columns={[
          {
            title: 'Name',
            dataIndex: 'name',
            key: 'name',
            render: (name: string, p) => (
              <div>
                <div style={{ fontWeight: 500 }}>
                  {name} {p.id === defaultId ? <Tag color="blue">default</Tag> : null}{' '}
                  {p.builtin ? <Tag>built-in</Tag> : null}
                </div>
                <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>{p.id}</div>
              </div>
            ),
          },
          {
            title: 'Description',
            dataIndex: 'description',
            key: 'description',
            render: (d: string | null) =>
              d ? d : <Typography.Text type="secondary">—</Typography.Text>,
          },
          {
            title: 'Model',
            dataIndex: 'model',
            key: 'model',
            width: 200,
            render: (m: string | null) =>
              m ? (
                <Typography.Text code>{m}</Typography.Text>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          {
            title: 'Tools',
            dataIndex: 'toolset',
            key: 'toolset',
            width: 100,
            align: 'right',
            render: (t: string[] | null) => t?.length ?? 0,
          },
          {
            title: '',
            key: 'actions',
            width: 240,
            render: (_, p) => (
              <PersonalityRowActions
                personality={p}
                onEdit={() => setEditingId(p.id)}
                onDuplicate={() => setDuplicatePrompt(p)}
              />
            ),
          },
        ]}
      />

      {createOpen ? (
        <CreateWizard
          existingIds={new Set(personalities.map((p) => p.id))}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
      {editingId ? (
        <EditModal key={editingId} id={editingId} onClose={() => setEditingId(null)} />
      ) : null}
      {duplicatePrompt ? (
        <DuplicateModal
          source={duplicatePrompt}
          existingIds={new Set(personalities.map((p) => p.id))}
          onClose={() => setDuplicatePrompt(null)}
          onDone={(newId) => {
            setDuplicatePrompt(null);
            setEditingId(newId);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------

function PersonalityRowActions({
  personality,
  onEdit,
  onDuplicate,
}: {
  personality: Personality;
  onEdit: () => void;
  onDuplicate: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const deleteMut = useMutation({
    mutationFn: (id: string) => rpc.personalities.delete({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
      notification.success({ message: `Deleted ${personality.name}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Delete failed', description: (err as Error).message }),
  });

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {personality.builtin ? null : (
        <Button size="small" onClick={onEdit}>
          Edit
        </Button>
      )}
      <Tooltip title={personality.builtin ? 'Built-in — duplicate to edit.' : undefined}>
        <Button size="small" onClick={onDuplicate}>
          Duplicate
        </Button>
      </Tooltip>
      {personality.builtin ? null : (
        <Popconfirm
          title={`Delete ${personality.name}?`}
          description="The directory under ~/.ethos/personalities/ is removed."
          onConfirm={() => deleteMut.mutate(personality.id)}
          okText="Delete"
          okButtonProps={{ danger: true }}
        >
          <Button size="small" danger loading={deleteMut.isPending}>
            Delete
          </Button>
        </Popconfirm>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create wizard (4 steps)
// ---------------------------------------------------------------------------

interface WizardState {
  id: string;
  name: string;
  description: string;
  model: string;
  provider: string;
  capabilities: string[];
  fsReachRead: string[];
  fsReachWrite: string[];
  toolset: string[];
  soulMd: string;
  skills: string[];
  mcpServers: string[];
  plugins: string[];
}

const SOUL_TEMPLATE = `# About me\n\nI am a {role}. I {what I do}. I {how I work}.\n\n## How I respond\n\n- {tone / shape}\n- {tone / shape}\n- {tone / shape}\n`;

function CreateWizard({ existingIds, onClose }: { existingIds: Set<string>; onClose: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [state, setState] = useState<WizardState>({
    id: '',
    name: '',
    description: '',
    model: '',
    provider: '',
    capabilities: [],
    fsReachRead: [],
    fsReachWrite: [],
    toolset: [
      'memory_read',
      'memory_write',
      'session_search',
      'create_cron_job',
      'list_cron_jobs',
      'delete_cron_job',
      'pause_cron_job',
      'resume_cron_job',
      'run_cron_job_now',
    ],
    soulMd: SOUL_TEMPLATE,
    skills: [],
    mcpServers: [],
    plugins: [],
  });

  const pluginsQuery = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const createMut = useMutation({
    mutationFn: () =>
      rpc.personalities.create({
        id: state.id,
        name: state.name,
        ...(state.description ? { description: state.description } : {}),
        ...(state.model ? { model: state.model } : {}),
        ...(state.provider ? { provider: state.provider as ProviderId } : {}),
        ...(state.capabilities.length > 0 ? { capabilities: state.capabilities } : {}),
        ...(state.fsReachRead.length > 0 || state.fsReachWrite.length > 0
          ? { fs_reach: { read: state.fsReachRead, write: state.fsReachWrite } }
          : {}),
        ...(state.mcpServers.length > 0 ? { mcp_servers: state.mcpServers } : {}),
        ...(state.plugins.length > 0 ? { plugins: state.plugins } : {}),
        toolset: state.toolset,
        soulMd: state.soulMd,
      }),
    onSuccess: async () => {
      if (state.skills.length > 0) {
        try {
          await rpc.personalities.skillsImportGlobal({
            personalityId: state.id,
            skillIds: state.skills,
          });
        } catch {
          notification.warning({
            message: `Created ${state.name}, but skill attachment failed`,
            description: 'Open the personality editor to attach skills manually.',
            placement: 'topRight',
          });
          qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
          qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
          onClose();
          return;
        }
      }
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
      notification.success({ message: `Created ${state.name}`, placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Create failed', description: (err as Error).message }),
  });

  const idValid = /^[a-z0-9_-]+$/.test(state.id);
  const nameValid = state.name.trim().length > 0;
  const idCollision = existingIds.has(state.id);
  const canCreate = idValid && nameValid && !idCollision && state.soulMd.length > 0;

  const mcpServers = pluginsQuery.data?.mcpServers ?? [];
  const availablePlugins = pluginsQuery.data?.plugins ?? [];

  return (
    <Modal
      open
      title="New personality"
      onCancel={onClose}
      width={720}
      destroyOnClose
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            disabled={!canCreate}
            loading={createMut.isPending}
            onClick={() => createMut.mutate()}
          >
            Create
          </Button>
        </div>
      }
    >
      <Tabs
        defaultActiveKey="basics"
        items={[
          {
            key: 'basics',
            label: 'Basics',
            children: <IdentityStep state={state} setState={setState} idCollision={idCollision} />,
          },
          {
            key: 'soul',
            label: 'Soul',
            children: <SoulMdStep state={state} setState={setState} />,
          },
          {
            key: 'config',
            label: 'Config',
            children: <WizardConfigTab state={state} setState={setState} />,
          },
          {
            key: 'toolset',
            label: 'Toolset',
            children: <ToolsetStep state={state} setState={setState} />,
          },
          {
            key: 'skills',
            label: 'Skills',
            children: <WizardSkillsStep state={state} setState={setState} />,
          },
          {
            key: 'mcp',
            label: 'MCP',
            children: (
              <WizardMcpTab
                servers={mcpServers}
                loading={pluginsQuery.isLoading}
                selected={state.mcpServers}
                onChange={(next) => setState((s) => ({ ...s, mcpServers: next }))}
              />
            ),
          },
          {
            key: 'plugins',
            label: 'Plugins',
            children: (
              <WizardPluginsTab
                plugins={availablePlugins}
                loading={pluginsQuery.isLoading}
                selected={state.plugins}
                onChange={(next) => setState((s) => ({ ...s, plugins: next }))}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
}

function IdentityStep({
  state,
  setState,
  idCollision,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
  idCollision: boolean;
}) {
  return (
    <Form layout="vertical">
      <Form.Item label="Name" required help="Display name. The id below is derived from this.">
        <Input
          autoFocus
          value={state.name}
          placeholder="e.g. Strategist"
          onChange={(e) => {
            const name = e.target.value;
            const derivedId = name
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9_-]/g, '');
            setState((s) => ({ ...s, name, id: s.id === slugify(s.name) ? derivedId : s.id }));
          }}
        />
      </Form.Item>
      <Form.Item
        label="ID"
        required
        validateStatus={idCollision ? 'error' : undefined}
        help={
          idCollision
            ? 'Already taken by an existing personality.'
            : 'Lowercase, dash/underscore-separated. Becomes the directory name.'
        }
      >
        <Input
          value={state.id}
          placeholder="strategist"
          onChange={(e) => setState((s) => ({ ...s, id: e.target.value.toLowerCase() }))}
        />
      </Form.Item>
      <Form.Item label="Description" help="One-line summary, optional.">
        <Input
          value={state.description}
          placeholder="What this personality is good at."
          onChange={(e) => setState((s) => ({ ...s, description: e.target.value }))}
        />
      </Form.Item>
    </Form>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

function ToolsetStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  const catalogQuery = useQuery({
    queryKey: ['tools', 'catalog'],
    queryFn: () => rpc.tools.catalog({}),
  });
  const TOOL_GROUPS = (catalogQuery.data?.groups ?? []).map((g) => ({
    group: g.group,
    tools: g.tools.map((t) => t.name),
  }));

  const toggle = (name: string) => {
    setState((s) => {
      const has = s.toolset.includes(name);
      return { ...s, toolset: has ? s.toolset.filter((t) => t !== name) : [...s.toolset, name] };
    });
  };

  if (catalogQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  return (
    <div>
      <Typography.Paragraph type="secondary">
        Pick the tools this personality can call. Memory and cron tools are pre-selected as
        recommended defaults. You can edit this later.
      </Typography.Paragraph>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {TOOL_GROUPS.map((group) => (
          <section key={group.group}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.55)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: 6,
              }}
            >
              {group.group}
              {group.group === 'Memory' || group.group === 'Cron' ? (
                <Tag
                  color="blue"
                  bordered={false}
                  style={{ fontSize: 10, marginLeft: 6, verticalAlign: 'middle' }}
                >
                  recommended
                </Tag>
              ) : null}
            </div>
            {group.group === 'Cron' ? (
              <Typography.Text
                type="secondary"
                style={{ fontSize: 11, display: 'block', marginBottom: 4 }}
              >
                Requires a running CronScheduler (serve/gateway mode).
              </Typography.Text>
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {group.tools.map((tool) => {
                const enabled = state.toolset.includes(tool);
                return (
                  <Tag.CheckableTag
                    key={tool}
                    checked={enabled}
                    onChange={() => toggle(tool)}
                    style={{ padding: '4px 10px', fontSize: 12 }}
                  >
                    {tool}
                  </Tag.CheckableTag>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function SoulMdStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary">
        First-person identity. The agent reads this on every turn — keep it short and concrete.
        Avoid "🚀 ready to help!" boilerplate.
      </Typography.Paragraph>
      <Form.Item required>
        <Input.TextArea
          value={state.soulMd}
          autoSize={{ minRows: 12, maxRows: 24 }}
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
          onChange={(e) => setState((s) => ({ ...s, soulMd: e.target.value }))}
        />
      </Form.Item>
    </Form>
  );
}

function WizardSkillsStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  const skillsQuery = useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => rpc.skills.list(),
  });

  if (skillsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  const skills = skillsQuery.data?.skills ?? [];

  if (skills.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No skills in the global library. Create skills on the Skills page first."
      />
    );
  }

  const selectedSet = new Set(state.skills);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Typography.Paragraph type="secondary">
        Select skills to attach from the global library. Skills can also be added after creation.
      </Typography.Paragraph>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {skills.map((s) => (
          <Checkbox
            key={s.id}
            checked={selectedSet.has(s.id)}
            onChange={(e) => {
              setState((prev) => {
                const next = new Set(prev.skills);
                if (e.target.checked) next.add(s.id);
                else next.delete(s.id);
                return { ...prev, skills: [...next] };
              });
            }}
          >
            <span style={{ fontWeight: 500 }}>{s.name}</span>
            {s.description ? (
              <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                {s.description}
              </Typography.Text>
            ) : null}
          </Checkbox>
        ))}
      </div>
    </div>
  );
}

function WizardConfigTab({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary">
        Optional. Leave blank to use the global default from Settings.
      </Typography.Paragraph>
      <Form.Item label="Model" help="e.g. claude-opus-4-7, gpt-4o, moonshotai/kimi-k2.6">
        <Input
          value={state.model}
          placeholder="claude-opus-4-7"
          onChange={(e) => setState((s) => ({ ...s, model: e.target.value }))}
        />
      </Form.Item>
      <Form.Item
        label="Provider"
        extra="Engine default is set in Settings. Set this only if this personality must route to a specific provider."
      >
        <Select
          allowClear
          placeholder="engine default"
          value={state.provider || undefined}
          onChange={(val) => setState((s) => ({ ...s, provider: val ?? '' }))}
          options={[
            { label: 'Anthropic', value: 'anthropic' },
            { label: 'OpenAI', value: 'openai' },
            { label: 'OpenRouter', value: 'openrouter' },
            { label: 'OpenAI Compatible', value: 'openai-compat' },
            { label: 'Ollama', value: 'ollama' },
            { label: 'Azure', value: 'azure' },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Capabilities"
        extra="Free-form labels used by the mesh router and operator filtering. e.g. triage, release, cost-sensitive."
      >
        <Select
          mode="tags"
          allowClear
          placeholder="add capability tags"
          tokenSeparators={[',']}
          value={state.capabilities}
          onChange={(val) => setState((s) => ({ ...s, capabilities: val }))}
        />
      </Form.Item>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="Filesystem reach"
        description="These paths control which directories this personality can read and write. Adding broad paths (e.g. /, /home) lets the personality access anything inside. Edit only if you understand the implications."
      />
      <Form.Item label="Read paths">
        <Select
          mode="tags"
          allowClear
          placeholder={FS_REACH_READ_PLACEHOLDER}
          tokenSeparators={[',']}
          value={state.fsReachRead}
          onChange={(val) => setState((s) => ({ ...s, fsReachRead: val }))}
        />
      </Form.Item>
      <Form.Item label="Write paths">
        <Select
          mode="tags"
          allowClear
          placeholder="e.g. /data/output"
          tokenSeparators={[',']}
          value={state.fsReachWrite}
          onChange={(val) => setState((s) => ({ ...s, fsReachWrite: val }))}
        />
      </Form.Item>
    </Form>
  );
}

function WizardMcpTab({
  servers,
  loading,
  selected,
  onChange,
}: {
  servers: McpServerInfo[];
  loading: boolean;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No MCP servers configured. Edit{' '}
            <Typography.Text code>~/.ethos/mcp.json</Typography.Text>.
          </span>
        }
      />
    );
  }

  const selectedSet = new Set(selected);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        Check each MCP server this personality can reach. Unchecked servers are invisible to this
        role.
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
        Choose specific tools per server after creating the personality — edit it once the server's
        credentials are connected.
      </Typography.Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {servers.map((s) => (
          <Checkbox
            key={s.name}
            checked={selectedSet.has(s.name)}
            onChange={(e) => {
              const next = new Set(selectedSet);
              if (e.target.checked) next.add(s.name);
              else next.delete(s.name);
              onChange([...next]);
            }}
            aria-label={`Enable MCP server ${s.name}`}
          >
            <span style={{ fontWeight: 500 }}>{s.name}</span>{' '}
            <Tag bordered={false} style={{ fontSize: 11 }}>
              {s.transport}
            </Tag>
            {s.command ? (
              <Typography.Text
                type="secondary"
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
              >
                {s.command}
              </Typography.Text>
            ) : s.url ? (
              <Typography.Text
                type="secondary"
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
              >
                {s.url}
              </Typography.Text>
            ) : null}
          </Checkbox>
        ))}
      </div>
    </div>
  );
}

function WizardPluginsTab({
  plugins,
  loading,
  selected,
  onChange,
}: {
  plugins: PluginInfo[];
  loading: boolean;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  if (plugins.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No plugins installed.{' '}
            <Typography.Text code>ethos plugin install &lt;path&gt;</Typography.Text>
          </span>
        }
      />
    );
  }

  const selectedSet = new Set(selected);

  function toggle(pluginId: string, on: boolean) {
    const next = new Set(selectedSet);
    if (on) next.add(pluginId);
    else next.delete(pluginId);
    onChange([...next]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {selectedSet.size === 0 ? (
        <Alert
          type="info"
          showIcon
          message="0 plugins attached"
          description="Toggle a plugin below to enable it for this personality."
          style={{ marginBottom: 4 }}
        />
      ) : null}
      {plugins.map((p) => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <Switch
            size="small"
            checked={selectedSet.has(p.id)}
            onChange={(on) => toggle(p.id, on)}
            aria-label={`Attach ${p.name}`}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>{p.name}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography.Text
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
                type="secondary"
              >
                {p.id}
              </Typography.Text>
              <Tag bordered={false} style={{ fontSize: 11 }}>
                {p.source}
              </Tag>
              {p.pluginContractMajor !== null ? (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  v{p.pluginContractMajor}
                </Typography.Text>
              ) : null}
            </div>
            {p.description ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {p.description}
              </Typography.Text>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit modal — three tabs (Identity / Toolset / Config) + Skills sub-surface
// ---------------------------------------------------------------------------

function EditModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['personalities', 'get', id],
    queryFn: () => rpc.personalities.get({ id }),
  });

  return (
    <Modal open title={`Edit ${id}`} onCancel={onClose} footer={null} width={780} destroyOnClose>
      {isLoading || !data ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 240 }}>
          <Spin />
        </div>
      ) : data.personality.builtin ? (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="This personality is built-in and cannot be edited. Duplicate to make a writable copy."
            action={
              <Button
                size="small"
                onClick={() => {
                  onClose();
                }}
              >
                Duplicate
              </Button>
            }
          />
          <CharacterSheetPanel id={id} />
        </>
      ) : (
        <Tabs
          defaultActiveKey="characterSheet"
          items={[
            {
              key: 'characterSheet',
              label: 'Character sheet',
              children: <CharacterSheetPanel id={id} />,
            },
            {
              key: 'identity',
              label: 'Identity',
              children: <IdentityEditor id={id} initialSoulMd={data.soulMd} />,
            },
            {
              key: 'toolset',
              label: 'Toolset',
              children: <ToolsetEditor id={id} initialToolset={data.personality.toolset ?? []} />,
            },
            {
              key: 'config',
              label: 'Config',
              children: <ConfigEditor id={id} personality={data.personality} />,
            },
            {
              key: 'skills',
              label: 'Skills',
              children: <PersonalitySkillsPanel personalityId={id} />,
            },
            {
              key: 'mcp',
              label: 'MCP',
              children: (
                <McpServersPanel
                  id={id}
                  initialMcpServers={data.personality.mcp_servers ?? []}
                  initialMcpPolicy={data.mcpPolicy}
                />
              ),
            },
            {
              key: 'plugins',
              label: 'Plugins',
              children: (
                <PluginsAttachPanel id={id} initialPlugins={data.personality.plugins ?? []} />
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}

// The generated character sheet — one screen of what the personality is,
// what it has, and what it can reach. Same Markdown artifact `ethos
// personality show` prints; rendered read-only here as the primary read.
function CharacterSheetPanel({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['personalities', 'characterSheet', id],
    queryFn: () => rpc.personalities.characterSheet({ id }),
  });

  if (isLoading || !data) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 240 }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Auto-generated from config + SOUL.md — the same artifact <code>ethos personality show</code>{' '}
        prints.
      </Typography.Paragraph>
      <pre
        style={{
          fontFamily: 'Geist Mono, monospace',
          fontSize: 12.5,
          whiteSpace: 'pre-wrap',
          margin: 0,
        }}
      >
        {data.markdown}
      </pre>
    </>
  );
}

function IdentityEditor({ id, initialSoulMd }: { id: string; initialSoulMd: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [draft, setDraft] = useState(initialSoulMd);

  const mut = useMutation({
    mutationFn: () => rpc.personalities.update({ id, soulMd: draft }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'SOUL.md saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        First-person identity body. The agent loads this each turn.
      </Typography.Paragraph>
      <Form.Item>
        <Input.TextArea
          value={draft}
          autoSize={{ minRows: 14, maxRows: 30 }}
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Form.Item>
      <Button
        type="primary"
        disabled={draft === initialSoulMd}
        loading={mut.isPending}
        onClick={() => mut.mutate()}
      >
        Save
      </Button>
    </Form>
  );
}

function ToolsetEditor({ id, initialToolset }: { id: string; initialToolset: string[] }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [draft, setDraft] = useState(initialToolset.join('\n'));

  const mut = useMutation({
    mutationFn: () =>
      rpc.personalities.update({
        id,
        toolset: draft
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'Toolset saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        One tool per line. Blank lines ignored. Tool names follow{' '}
        <Typography.Text code>tool_name_in_snake_case</Typography.Text>.
      </Typography.Paragraph>
      <Form.Item>
        <Input.TextArea
          value={draft}
          autoSize={{ minRows: 12, maxRows: 24 }}
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Form.Item>
      <Button
        type="primary"
        disabled={draft === initialToolset.join('\n')}
        loading={mut.isPending}
        onClick={() => mut.mutate()}
      >
        Save
      </Button>
    </Form>
  );
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text for the UI, not a template variable
const FS_REACH_READ_PLACEHOLDER = 'e.g. /data, ${self}/docs';

function ConfigEditor({ id, personality }: { id: string; personality: Personality }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{
    name: string;
    description: string;
    provider: ProviderId | '';
    model: string;
    capabilities: string[];
    fsReachRead: string[];
    fsReachWrite: string[];
  }>();

  useEffect(() => {
    form.setFieldsValue({
      name: personality.name,
      description: personality.description ?? '',
      provider: (personality.provider ?? '') as ProviderId | '',
      model: personality.model ?? '',
      capabilities: personality.capabilities ?? [],
      fsReachRead: personality.fs_reach?.read ?? [],
      fsReachWrite: personality.fs_reach?.write ?? [],
    });
  }, [personality, form]);

  const mut = useMutation({
    mutationFn: (values: {
      name: string;
      description: string;
      provider: ProviderId | '';
      model: string;
      capabilities: string[];
      fsReachRead: string[];
      fsReachWrite: string[];
    }) =>
      rpc.personalities.update({
        id,
        name: values.name,
        description: values.description,
        model: values.model,
        provider: values.provider || '',
        capabilities: values.capabilities,
        fs_reach: { read: values.fsReachRead, write: values.fsReachWrite },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'Config saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={(values) =>
        mut.mutate({
          name: values.name,
          description: values.description,
          provider: values.provider,
          model: values.model,
          capabilities: values.capabilities ?? [],
          fsReachRead: values.fsReachRead ?? [],
          fsReachWrite: values.fsReachWrite ?? [],
        })
      }
    >
      <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Required' }]}>
        <Input />
      </Form.Item>
      <Form.Item label="Description" name="description">
        <Input />
      </Form.Item>
      <Form.Item
        label="Provider"
        name="provider"
        extra="Engine default is set in Settings. Set this only if this personality must route to a specific provider."
      >
        <Select
          allowClear
          placeholder="engine default"
          options={[
            { label: 'Anthropic', value: 'anthropic' },
            { label: 'OpenAI', value: 'openai' },
            { label: 'OpenRouter', value: 'openrouter' },
            { label: 'OpenAI Compatible', value: 'openai-compat' },
            { label: 'Ollama', value: 'ollama' },
            { label: 'Azure', value: 'azure' },
          ]}
        />
      </Form.Item>
      <Form.Item label="Model" name="model">
        <Input placeholder="optional override" />
      </Form.Item>
      <Form.Item label="Memory scope">
        <Typography.Text>per-personality</Typography.Text>
      </Form.Item>
      <Form.Item
        label="Capabilities"
        name="capabilities"
        extra="Free-form labels used by the mesh router and operator filtering. e.g. triage, release, cost-sensitive."
      >
        <Select mode="tags" allowClear placeholder="add capability tags" tokenSeparators={[',']} />
      </Form.Item>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="Filesystem reach"
        description="These paths control which directories this personality can read and write. Adding broad paths (e.g. /, /home) lets the personality access anything inside. Edit only if you understand the implications."
      />
      <Form.Item label="Read paths" name="fsReachRead">
        <Select
          mode="tags"
          allowClear
          placeholder={FS_REACH_READ_PLACEHOLDER}
          tokenSeparators={[',']}
        />
      </Form.Item>
      <Form.Item label="Write paths" name="fsReachWrite">
        <Select mode="tags" allowClear placeholder="e.g. /data/output" tokenSeparators={[',']} />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={mut.isPending}>
          Save
        </Button>
      </Form.Item>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Per-personality skills panel
// ---------------------------------------------------------------------------

function PersonalitySkillsPanel({ personalityId }: { personalityId: string }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<PersonalitySkill | null>(null);

  const skillsQuery = useQuery({
    queryKey: ['personalities', 'skills', personalityId],
    queryFn: () => rpc.personalities.skillsList({ personalityId }),
  });

  if (skillsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (skillsQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load skills: {(skillsQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const skills = skillsQuery.data?.skills ?? [];

  return (
    <>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {skills.length} {skills.length === 1 ? 'skill' : 'skills'} for this personality
        </Typography.Text>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => setImportOpen(true)}>Import from global</Button>
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            New skill
          </Button>
        </div>
      </header>

      <Table<PersonalitySkill>
        rowKey="id"
        dataSource={skills}
        pagination={false}
        size="small"
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No personality-specific skills. Import from the global library or create one."
            />
          ),
        }}
        columns={[
          {
            title: 'Name',
            dataIndex: 'name',
            key: 'name',
            render: (name: string, s) => (
              <div>
                <div style={{ fontWeight: 500 }}>{name}</div>
                <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>{s.id}.md</div>
              </div>
            ),
          },
          {
            title: 'Description',
            dataIndex: 'description',
            key: 'description',
            render: (d: string | null) =>
              d ? d : <Typography.Text type="secondary">—</Typography.Text>,
          },
          {
            title: '',
            key: 'actions',
            width: 160,
            render: (_, s) => (
              <PersonalitySkillRowActions
                personalityId={personalityId}
                skill={s}
                onEdit={() => setEditing(s)}
              />
            ),
          },
        ]}
      />

      {createOpen ? (
        <CreatePersonalitySkillModal
          personalityId={personalityId}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
      {importOpen ? (
        <ImportGlobalSkillsModal
          personalityId={personalityId}
          existingIds={new Set(skills.map((s) => s.id))}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
      {editing ? (
        <EditPersonalitySkillModal
          key={editing.id}
          personalityId={personalityId}
          skill={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function PersonalitySkillRowActions({
  personalityId,
  skill,
  onEdit,
}: {
  personalityId: string;
  skill: PersonalitySkill;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const deleteMut = useMutation({
    mutationFn: () => rpc.personalities.skillsDelete({ personalityId, skillId: skill.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'skills', personalityId] });
      notification.success({ message: `Deleted ${skill.name}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Delete failed', description: (err as Error).message }),
  });
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button size="small" onClick={onEdit}>
        Edit
      </Button>
      <Popconfirm
        title="Delete this skill?"
        onConfirm={() => deleteMut.mutate()}
        okText="Delete"
        okButtonProps={{ danger: true }}
      >
        <Button size="small" danger>
          Delete
        </Button>
      </Popconfirm>
    </div>
  );
}

function CreatePersonalitySkillModal({
  personalityId,
  onClose,
}: {
  personalityId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{ skillId: string; body: string }>();

  const createMut = useMutation({
    mutationFn: (values: { skillId: string; body: string }) =>
      rpc.personalities.skillsCreate({ personalityId, skillId: values.skillId, body: values.body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'skills', personalityId] });
      notification.success({ message: 'Skill created', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Create failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open
      title="New skill"
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Create"
      okButtonProps={{ loading: createMut.isPending }}
      destroyOnClose
      width={680}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => createMut.mutate(v)}
        initialValues={{
          body: '---\nname: my-skill\ndescription: One-line summary\n---\n\nWrite the skill body here.\n',
        }}
      >
        <Form.Item
          label="ID"
          name="skillId"
          rules={[
            { required: true, message: 'Required' },
            { pattern: /^[a-zA-Z0-9_-]+$/, message: 'Letters, digits, dash, underscore only.' },
          ]}
        >
          <Input autoFocus />
        </Form.Item>
        <Form.Item label="Body" name="body" rules={[{ required: true }]}>
          <Input.TextArea rows={14} style={{ fontFamily: 'Geist Mono, monospace' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function EditPersonalitySkillModal({
  personalityId,
  skill,
  onClose,
}: {
  personalityId: string;
  skill: PersonalitySkill;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [body, setBody] = useState(skill.body);

  const mut = useMutation({
    mutationFn: () => rpc.personalities.skillsUpdate({ personalityId, skillId: skill.id, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'skills', personalityId] });
      notification.success({ message: 'Saved', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open
      title={`Edit ${skill.name}`}
      onCancel={onClose}
      onOk={() => mut.mutate()}
      okText="Save"
      okButtonProps={{ loading: mut.isPending, disabled: body === skill.body }}
      destroyOnClose
      width={680}
    >
      <Input.TextArea
        value={body}
        autoSize={{ minRows: 14, maxRows: 24 }}
        style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
        onChange={(e) => setBody(e.target.value)}
      />
    </Modal>
  );
}

function ImportGlobalSkillsModal({
  personalityId,
  existingIds,
  onClose,
}: {
  personalityId: string;
  existingIds: Set<string>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [selected, setSelected] = useState<string[]>([]);

  const globalQuery = useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => rpc.skills.list(),
  });

  const importMut = useMutation({
    mutationFn: () => rpc.personalities.skillsImportGlobal({ personalityId, skillIds: selected }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['personalities', 'skills', personalityId] });
      notification.success({
        message: `Imported ${result.imported.length} skill${result.imported.length === 1 ? '' : 's'}`,
        placement: 'topRight',
      });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Import failed', description: (err as Error).message }),
  });

  const importable = useMemo(
    () => (globalQuery.data?.skills ?? []).filter((s) => !existingIds.has(s.id)),
    [globalQuery.data, existingIds],
  );

  return (
    <Modal
      open
      title="Import skills from global library"
      onCancel={onClose}
      onOk={() => importMut.mutate()}
      okText="Import"
      okButtonProps={{
        loading: importMut.isPending,
        disabled: selected.length === 0,
      }}
      destroyOnClose
      width={620}
    >
      {globalQuery.isLoading ? (
        <Spin />
      ) : importable.length === 0 ? (
        <Empty description="Every global skill is already imported (or the global library is empty)." />
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
            Skills already in this personality are excluded. Imported skills become independent
            copies; later edits to the global file don't propagate.
          </Typography.Paragraph>
          <Select
            mode="multiple"
            value={selected}
            onChange={setSelected}
            style={{ width: '100%' }}
            placeholder="Pick skills to copy in"
            options={importable.map((s) => ({ label: `${s.name} — ${s.id}`, value: s.id }))}
          />
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Duplicate modal — pick a new id, then open the editor on the copy
// ---------------------------------------------------------------------------

function DuplicateModal({
  source,
  existingIds,
  onClose,
  onDone,
}: {
  source: Personality;
  existingIds: Set<string>;
  onClose: () => void;
  onDone: (newId: string) => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [newId, setNewId] = useState(`${source.id}-copy`);

  const mut = useMutation({
    mutationFn: () => rpc.personalities.duplicate({ id: source.id, newId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
      notification.success({ message: `Duplicated → ${newId}`, placement: 'topRight' });
      onDone(newId);
    },
    onError: (err) =>
      notification.error({ message: 'Duplicate failed', description: (err as Error).message }),
  });

  const idValid = /^[a-z0-9_-]+$/.test(newId);
  const collision = existingIds.has(newId);

  return (
    <Modal
      open
      title={`Duplicate ${source.name}`}
      onCancel={onClose}
      onOk={() => mut.mutate()}
      okText="Duplicate"
      okButtonProps={{ loading: mut.isPending, disabled: !idValid || collision }}
      destroyOnClose
    >
      <Form layout="vertical">
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Copies all four files (SOUL.md, toolset.yaml, config.yaml, skills/) into{' '}
          <Typography.Text code>~/.ethos/personalities/&lt;new-id&gt;/</Typography.Text>. The editor
          opens on the copy when this completes.
        </Typography.Paragraph>
        <Form.Item
          label="New ID"
          required
          validateStatus={collision ? 'error' : !idValid && newId ? 'error' : undefined}
          help={
            collision
              ? 'Already taken.'
              : !idValid
                ? 'Lowercase, dash/underscore-separated.'
                : undefined
          }
        >
          <Input autoFocus value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// MCP servers panel — checkbox list of all configured MCP servers, each with
// a per-server tool checklist (loaded from the personality's mcp.yaml).
// Saves via personalities.update({ mcp_servers, mcp_tools }).
// ---------------------------------------------------------------------------

// Per-server tool selection state held in the parent so Save can build the
// `mcp_tools` payload. `tools` is the set of discovered tool names; `null`
// means tools have not been discovered yet (or the server is unreachable).
type ServerToolState = {
  /** All bare tool names the server exposes, or null when undiscovered. */
  tools: string[] | null;
  /** Currently-checked bare tool names. */
  selected: Set<string>;
};

// A server with no `tools` entry in mcp.yaml = all tools allowed.
function initialSelectionFor(serverName: string, policy: McpPolicy | null): string[] | undefined {
  return policy?.servers?.[serverName]?.tools;
}

function ServerToolChecklist({
  personalityId,
  serverName,
  state,
  onDiscovered,
  onToggle,
}: {
  personalityId: string;
  serverName: string;
  state: ServerToolState | undefined;
  onDiscovered: (tools: string[]) => void;
  onToggle: (toolName: string) => void;
}) {
  const toolsQuery = useQuery({
    queryKey: ['mcp', 'serverTools', personalityId, serverName],
    queryFn: () => rpc.mcp.serverTools({ personalityId, serverName }),
  });

  // Lift the discovered tool list into the parent once, when it arrives.
  useEffect(() => {
    if (toolsQuery.data && state?.tools == null) {
      onDiscovered(toolsQuery.data.tools.map((t) => t.name));
    }
  }, [toolsQuery.data, state?.tools, onDiscovered]);

  if (toolsQuery.isLoading) {
    return (
      <div style={{ paddingLeft: 24, paddingTop: 4 }}>
        <Spin size="small" />
      </div>
    );
  }

  const available = toolsQuery.data?.available ?? false;
  const tools = toolsQuery.data?.tools ?? [];

  if (!available || tools.length === 0) {
    return (
      <Typography.Text
        type="secondary"
        style={{ fontSize: 11, display: 'block', paddingLeft: 24, paddingTop: 2 }}
      >
        Tool list unavailable — the server is not connected. All of its tools remain allowed.
      </Typography.Text>
    );
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingLeft: 24, paddingTop: 4 }}>
      {tools.map((tool) => (
        <Tag.CheckableTag
          key={tool.name}
          checked={state?.selected.has(tool.name) ?? true}
          onChange={() => onToggle(tool.name)}
          style={{ padding: '4px 10px', fontSize: 12 }}
        >
          {tool.name}
        </Tag.CheckableTag>
      ))}
    </div>
  );
}

function McpServersPanel({
  id,
  initialMcpServers,
  initialMcpPolicy,
}: {
  id: string;
  initialMcpServers: string[];
  initialMcpPolicy: McpPolicy | null;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [attached, setAttached] = useState<Set<string>>(new Set(initialMcpServers));
  const [toolState, setToolState] = useState<Record<string, ServerToolState>>({});
  const [dirty, setDirty] = useState(false);

  const pluginsQuery = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const mut = useMutation({
    mutationFn: () => {
      const mcpServers = [...attached];
      // Only servers that are a STRICT subset go into `mcp_tools`. A server
      // with every discovered tool checked (or undiscovered tools) is
      // omitted, which records "all tools allowed" in mcp.yaml.
      const mcpTools: Record<string, string[]> = {};
      for (const server of mcpServers) {
        const st = toolState[server];
        if (!st || st.tools == null) continue;
        if (st.selected.size < st.tools.length) {
          mcpTools[server] = st.tools.filter((t) => st.selected.has(t));
        }
      }
      return rpc.personalities.update({ id, mcp_servers: mcpServers, mcp_tools: mcpTools });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      setDirty(false);
      notification.success({ message: 'MCP servers saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const servers = pluginsQuery.data?.mcpServers ?? [];

  // Initialize a server's selection once its tools are discovered: tools
  // named in mcp.yaml's `tools` list are checked; with no entry, all are.
  const handleDiscovered = (serverName: string, discovered: string[]) => {
    setToolState((prev) => {
      if (prev[serverName]?.tools != null) return prev;
      const policyTools = initialSelectionFor(serverName, initialMcpPolicy);
      const selected = new Set(policyTools ?? discovered);
      return { ...prev, [serverName]: { tools: discovered, selected } };
    });
  };

  const handleToggle = (serverName: string, toolName: string) => {
    setToolState((prev) => {
      const st = prev[serverName];
      if (!st) return prev;
      const selected = new Set(st.selected);
      if (selected.has(toolName)) selected.delete(toolName);
      else selected.add(toolName);
      return { ...prev, [serverName]: { ...st, selected } };
    });
    setDirty(true);
  };

  if (pluginsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No MCP servers configured. Edit{' '}
            <Typography.Text code>~/.ethos/mcp.json</Typography.Text>.
          </span>
        }
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        Check each MCP server this personality can reach. Unchecked servers are invisible to this
        role. For an attached server, deselect tools to narrow what it can call.
      </Typography.Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {servers.map((s) => (
          <div key={s.name}>
            <Checkbox
              checked={attached.has(s.name)}
              onChange={(e) => {
                const next = new Set(attached);
                if (e.target.checked) next.add(s.name);
                else next.delete(s.name);
                setAttached(next);
                setDirty(true);
              }}
              aria-label={`Enable MCP server ${s.name} for ${id}`}
            >
              <span style={{ fontWeight: 500 }}>{s.name}</span>{' '}
              <Tag bordered={false} style={{ fontSize: 11 }}>
                {s.transport}
              </Tag>
              {s.command ? (
                <Typography.Text
                  type="secondary"
                  style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
                >
                  {s.command}
                </Typography.Text>
              ) : s.url ? (
                <Typography.Text
                  type="secondary"
                  style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
                >
                  {s.url}
                </Typography.Text>
              ) : null}
            </Checkbox>
            {attached.has(s.name) ? (
              <ServerToolChecklist
                personalityId={id}
                serverName={s.name}
                state={toolState[s.name]}
                onDiscovered={(tools) => handleDiscovered(s.name, tools)}
                onToggle={(toolName) => handleToggle(s.name, toolName)}
              />
            ) : null}
          </div>
        ))}
      </div>
      <Button
        type="primary"
        disabled={!dirty}
        loading={mut.isPending}
        onClick={() => mut.mutate()}
        style={{ alignSelf: 'flex-start' }}
      >
        Save
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugins attach panel — toggle per plugin, optimistic updates.
// Saves via personalities.update({ plugins: [...] }).
// ---------------------------------------------------------------------------

function PluginsAttachPanel({ id, initialPlugins }: { id: string; initialPlugins: string[] }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [attached, setAttached] = useState<Set<string>>(new Set(initialPlugins));

  const pluginsQuery = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const mut = useMutation({
    mutationFn: (next: string[]) => rpc.personalities.update({ id, plugins: next }),
    onMutate: () => ({ prev: new Set(attached) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
    },
    onError: (err, _vars, ctx) => {
      if (ctx) setAttached(ctx.prev);
      notification.error({ message: 'Save failed', description: (err as Error).message });
    },
  });

  const plugins = pluginsQuery.data?.plugins ?? [];

  if (pluginsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  if (plugins.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No plugins installed.{' '}
            <Typography.Text code>ethos plugin install &lt;path&gt;</Typography.Text>
          </span>
        }
      />
    );
  }

  function toggle(pluginId: string, on: boolean) {
    const next = new Set(attached);
    if (on) next.add(pluginId);
    else next.delete(pluginId);
    setAttached(next);
    mut.mutate([...next]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {attached.size === 0 ? (
        <Alert
          type="info"
          showIcon
          message="0 plugins attached"
          description="Toggle a plugin below to enable it for this personality."
          style={{ marginBottom: 4 }}
        />
      ) : null}
      {plugins.map((p) => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <Switch
            size="small"
            checked={attached.has(p.id)}
            loading={mut.isPending}
            onChange={(on) => toggle(p.id, on)}
            aria-label={`Attach ${p.name} to ${id}`}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>{p.name}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography.Text
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
                type="secondary"
              >
                {p.id}
              </Typography.Text>
              <Tag bordered={false} style={{ fontSize: 11 }}>
                {p.source}
              </Tag>
              {p.pluginContractMajor !== null ? (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  v{p.pluginContractMajor}
                </Typography.Text>
              ) : null}
            </div>
            {p.description ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {p.description}
              </Typography.Text>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
