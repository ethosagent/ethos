import type { EvolverRun, PendingSkill, Skill } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Badge,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { rpc } from '../rpc';

type SkillOrigin = 'built-in' | 'user' | 'evolver' | 'personality';
type OriginFilter = 'all' | SkillOrigin;

const ORIGIN_CONFIG: Record<SkillOrigin, { color: string; label: string }> = {
  'built-in': { color: 'blue', label: 'Built-in' },
  user: { color: 'green', label: 'User' },
  evolver: { color: 'orange', label: 'Evolver' },
  personality: { color: 'purple', label: 'Personality' },
};

function getSkillOrigin(skill: Skill): SkillOrigin {
  if (skill.source === 'system') return 'built-in';
  const scope = skill.frontmatter.scope;
  if (scope === 'evolver') return 'evolver';
  if (scope === 'personality') return 'personality';
  return 'user';
}

export function Skills() {
  const [activeTab, setActiveTab] = useState<'library' | 'evolver'>('library');

  const skillsQuery = useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => rpc.skills.list(),
  });

  const pendingCount = skillsQuery.data?.pendingCount ?? 0;

  return (
    <div className="skills-tab">
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'library' | 'evolver')}
        items={[
          {
            key: 'library',
            label: 'Library',
            children: <LibraryPanel skillsQuery={skillsQuery} />,
          },
          {
            key: 'evolver',
            label: (
              <span>
                Evolver{' '}
                {pendingCount > 0 ? <Badge count={pendingCount} style={{ marginLeft: 6 }} /> : null}
              </span>
            ),
            children: <EvolverPanel />,
          },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library panel — card grid with search, filter chips, origin badges
// ---------------------------------------------------------------------------

interface LibraryPanelProps {
  skillsQuery: ReturnType<typeof useQuery<{ skills: Skill[]; pendingCount: number }>>;
}

function LibraryPanel({ skillsQuery }: LibraryPanelProps) {
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');

  const skills = skillsQuery.data?.skills ?? [];

  const filteredSkills = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return skills.filter((skill) => {
      if (originFilter !== 'all' && getSkillOrigin(skill) !== originFilter) return false;
      if (q) {
        const name = skill.name.toLowerCase();
        const desc = (skill.description ?? '').toLowerCase();
        if (!name.includes(q) && !desc.includes(q)) return false;
      }
      return true;
    });
  }, [skills, searchQuery, originFilter]);

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

  const filterOptions: { key: OriginFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'built-in', label: 'Built-in' },
    { key: 'user', label: 'User' },
    { key: 'evolver', label: 'Evolver' },
    { key: 'personality', label: 'Personality' },
  ];

  return (
    <>
      <header className="page-header-row">
        <h1 className="page-h1">Skills</h1>
        <span className="page-subtitle">
          {filteredSkills.length} {filteredSkills.length === 1 ? 'skill' : 'skills'}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="page-action-btn" onClick={() => setCreateOpen(true)}>
          + New Skill
        </button>
      </header>

      <div className="skills-search">
        <Input.Search
          placeholder="Search skills by name or description..."
          allowClear
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="skills-filter-bar">
        {filterOptions.map((opt) => (
          <Button
            key={opt.key}
            className="skills-filter-chip"
            type={originFilter === opt.key ? 'primary' : 'default'}
            size="small"
            onClick={() => setOriginFilter(opt.key)}
          >
            {opt.label}
          </Button>
        ))}
      </div>

      {filteredSkills.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            skills.length === 0
              ? 'No skills installed yet. Create one to teach this agent how you work.'
              : 'No skills match the current filters.'
          }
        />
      ) : (
        <div className="skills-grid">
          {filteredSkills.map((skill) => {
            const origin = getSkillOrigin(skill);
            const config = ORIGIN_CONFIG[origin];
            return (
              <div key={skill.id} className="skill-card">
                <div className="skill-card-header">
                  <div style={{ fontWeight: 500 }}>{skill.name}</div>
                  <Tag color={config.color}>{config.label}</Tag>
                </div>
                <div className="skill-card-description">
                  {skill.description ?? (
                    <Typography.Text type="secondary">No description</Typography.Text>
                  )}
                </div>
                <div className="skill-card-meta">
                  <Typography.Text code style={{ fontSize: 11 }}>
                    {skill.id}.md
                  </Typography.Text>
                  <span>{formatRelative(skill.modifiedAt)}</span>
                </div>
                <div className="skill-card-actions">
                  <SkillCardActions skill={skill} onEdit={() => setEditingSkill(skill)} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {createOpen ? (
        <CreateSkillModal open={createOpen} onClose={() => setCreateOpen(false)} />
      ) : null}
      {editingSkill ? (
        <EditSkillModal
          key={editingSkill.id}
          skill={editingSkill}
          onClose={() => setEditingSkill(null)}
        />
      ) : null}
    </>
  );
}

function SkillCardActions({ skill, onEdit }: { skill: Skill; onEdit: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const deleteMut = useMutation({
    mutationFn: (id: string) => rpc.skills.delete({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: `Deleted ${skill.name}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Delete failed', description: (err as Error).message }),
  });

  if (skill.readonly) {
    return (
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="small" onClick={onEdit}>
          View
        </Button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button size="small" onClick={onEdit}>
        Edit
      </Button>
      <Popconfirm
        title="Delete this skill?"
        description="The file is removed from disk."
        onConfirm={() => deleteMut.mutate(skill.id)}
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

function CreateSkillModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{ id: string; body: string }>();

  const createMut = useMutation({
    mutationFn: (input: { id: string; body: string }) => rpc.skills.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Skill created', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Create failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open={open}
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
        onFinish={(values) => createMut.mutate(values)}
        initialValues={{
          body: '---\nname: my-skill\ndescription: One-line summary\n---\n\nWrite the skill body here.\n',
        }}
      >
        <Form.Item
          label="ID"
          name="id"
          rules={[
            { required: true, message: 'Required' },
            {
              pattern: /^[a-zA-Z0-9_-]+$/,
              message: 'Letters, digits, dash, underscore only.',
            },
          ]}
          extra="Becomes the filename. Cannot be changed later."
        >
          <Input autoFocus placeholder="e.g. summarize-pr" />
        </Form.Item>
        <Form.Item label="Body" name="body" rules={[{ required: true, message: 'Required' }]}>
          <Input.TextArea rows={14} style={{ fontFamily: 'Geist Mono, monospace' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function EditSkillModal({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{ body: string }>();
  const isReadonly = skill.readonly;

  // Reload the full body via skills.get on open — list returns it but we
  // still want a fresh read in case the file changed on disk between
  // opening the editor and saving.
  const { data, isLoading } = useQuery({
    queryKey: ['skills', 'get', skill.id],
    queryFn: () => rpc.skills.get({ id: skill.id }),
  });

  useEffect(() => {
    if (data?.skill) {
      // Reconstruct the source body the editor sees — frontmatter block +
      // markdown body. The wire schema gives us them separately.
      form.setFieldsValue({ body: rebuildBody(data.skill) });
    }
  }, [data, form]);

  const updateMut = useMutation({
    mutationFn: (body: string) => rpc.skills.update({ id: skill.id, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Saved', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open
      title={isReadonly ? `View ${skill.name}` : `Edit ${skill.name}`}
      onCancel={onClose}
      onOk={isReadonly ? onClose : () => form.submit()}
      okText={isReadonly ? 'Close' : 'Save'}
      okButtonProps={isReadonly ? {} : { loading: updateMut.isPending }}
      cancelButtonProps={isReadonly ? { style: { display: 'none' } } : {}}
      destroyOnClose
      width={680}
    >
      {isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      ) : (
        <Form form={form} layout="vertical" onFinish={(values) => updateMut.mutate(values.body)}>
          <Form.Item
            label="Body"
            name="body"
            rules={isReadonly ? [] : [{ required: true, message: 'Required' }]}
          >
            <Input.TextArea
              rows={18}
              style={{ fontFamily: 'Geist Mono, monospace' }}
              disabled={isReadonly}
            />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}

function rebuildBody(skill: Skill): string {
  const fmKeys = Object.keys(skill.frontmatter);
  if (fmKeys.length === 0) return skill.body;
  const lines = fmKeys.map((k) => `${k}: ${stringifyFrontmatterValue(skill.frontmatter[k])}`);
  return `---\n${lines.join('\n')}\n---\n\n${skill.body}`;
}

function stringifyFrontmatterValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Evolver panel — config form + pending queue + run history
// ---------------------------------------------------------------------------

function EvolverPanel() {
  return (
    <div className="evolver-panel">
      <Tabs
        defaultActiveKey="config"
        items={[
          { key: 'config', label: 'Config', children: <EvolverConfigForm /> },
          { key: 'pending', label: 'Approval queue', children: <PendingQueue /> },
          { key: 'history', label: 'Run history', children: <EvolverHistory /> },
        ]}
      />
    </div>
  );
}

function EvolverConfigForm() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm();

  const { data, isLoading, error } = useQuery({
    queryKey: ['evolver', 'config'],
    queryFn: () => rpc.evolver.configGet(),
  });

  useEffect(() => {
    if (data?.config) form.setFieldsValue(data.config);
  }, [data, form]);

  const updateMut = useMutation({
    mutationFn: (cfg: Parameters<typeof rpc.evolver.configUpdate>[0]) =>
      rpc.evolver.configUpdate(cfg),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evolver', 'config'] });
      notification.success({ message: 'Saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
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
        Failed to load config: {(error as Error).message}
      </Typography.Text>
    );
  }

  return (
    <Form
      form={form}
      layout="vertical"
      style={{ maxWidth: 480 }}
      onFinish={(values) => updateMut.mutate(values)}
    >
      <Form.Item
        label="Rewrite threshold"
        name="rewriteThreshold"
        extra="Skills with avg score below this are rewrite candidates. 0–1."
      >
        <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="New-skill pattern threshold"
        name="newSkillPatternThreshold"
        extra="Tasks scoring above this with no skill assistance can seed a new skill. 0–1."
      >
        <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Min runs before evolving a skill"
        name="minRunsBeforeEvolve"
        extra="Don't propose a rewrite until a skill has at least this many runs."
      >
        <InputNumber min={0} step={1} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Min pattern count for new skills"
        name="minPatternCount"
        extra="A new-skill candidate needs at least this many high-scoring sample tasks."
      >
        <InputNumber min={0} step={1} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Auto-approve evolved skills"
        name="autoApprove"
        valuePropName="checked"
        extra="When enabled, proposed skills are promoted directly to the live library without manual review."
      >
        <Switch />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={updateMut.isPending}>
          Save
        </Button>
      </Form.Item>
    </Form>
  );
}

function PendingQueue() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const { data, isLoading, error } = useQuery({
    queryKey: ['evolver', 'pending'],
    queryFn: () => rpc.evolver.pendingList(),
  });

  const approveMut = useMutation({
    mutationFn: (id: string) => rpc.evolver.pendingApprove({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evolver', 'pending'] });
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Approved — skill is now live.', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Approve failed', description: (err as Error).message }),
  });

  const rejectMut = useMutation({
    mutationFn: (id: string) => rpc.evolver.pendingReject({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evolver', 'pending'] });
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Rejected', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Reject failed', description: (err as Error).message }),
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
        Failed to load queue: {(error as Error).message}
      </Typography.Text>
    );
  }

  const pending = data?.pending ?? [];

  if (pending.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No pending candidates. Run `ethos skills evolve` against an eval JSONL to populate this queue."
      />
    );
  }

  return (
    <Table<PendingSkill>
      rowKey="id"
      dataSource={pending}
      pagination={false}
      size="small"
      expandable={{
        expandedRowRender: (row) => <PendingPreview skill={row} />,
      }}
      columns={[
        {
          title: 'Name',
          dataIndex: 'name',
          key: 'name',
          render: (name: string, row) => (
            <div>
              <div style={{ fontWeight: 500 }}>{name}</div>
              <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>{row.id}.md</div>
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
          title: 'Proposed',
          dataIndex: 'proposedAt',
          key: 'proposedAt',
          width: 140,
          render: (iso: string) => formatRelative(iso),
        },
        {
          title: '',
          key: 'actions',
          width: 200,
          render: (_, row) => (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                size="small"
                type="primary"
                onClick={() => approveMut.mutate(row.id)}
                loading={approveMut.isPending && approveMut.variables === row.id}
              >
                Approve
              </Button>
              <Popconfirm
                title="Reject this candidate?"
                description="The pending file is deleted."
                onConfirm={() => rejectMut.mutate(row.id)}
                okText="Reject"
                okButtonProps={{ danger: true }}
              >
                <Button size="small" danger>
                  Reject
                </Button>
              </Popconfirm>
            </div>
          ),
        },
      ]}
    />
  );
}

function PendingPreview({ skill }: { skill: PendingSkill }) {
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: 'Geist Mono, monospace',
        fontSize: 12,
        maxHeight: 320,
        overflow: 'auto',
        background: 'rgba(255,255,255,0.02)',
        padding: 12,
        borderRadius: 6,
        whiteSpace: 'pre-wrap',
      }}
    >
      {skill.body}
    </pre>
  );
}

function EvolverHistory() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['evolver', 'history'],
    queryFn: () => rpc.evolver.history({ limit: 50 }),
  });

  const runs = useMemo(() => data?.runs ?? [], [data]);

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
        Failed to load history: {(error as Error).message}
      </Typography.Text>
    );
  }
  if (runs.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No evolver runs recorded yet. Each run appends a line to ~/.ethos/evolver-history.jsonl."
      />
    );
  }
  return (
    <Table<EvolverRun>
      rowKey="ranAt"
      dataSource={runs}
      pagination={false}
      size="small"
      columns={[
        {
          title: 'Ran at',
          dataIndex: 'ranAt',
          key: 'ranAt',
          width: 180,
          render: (iso: string) => formatRelative(iso),
        },
        {
          title: 'Eval source',
          dataIndex: 'evalOutputPath',
          key: 'evalOutputPath',
          render: (p: string) => <Typography.Text code>{p}</Typography.Text>,
        },
        {
          title: 'Rewrites',
          dataIndex: 'rewritesProposed',
          key: 'rewritesProposed',
          width: 100,
          align: 'right',
        },
        {
          title: 'New',
          dataIndex: 'newSkillsProposed',
          key: 'newSkillsProposed',
          width: 80,
          align: 'right',
        },
        {
          title: 'Skipped',
          key: 'skipped',
          width: 100,
          align: 'right',
          render: (_, row) => row.skipped.length,
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
