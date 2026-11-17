import type { PersonalitySkill, Skill } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
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
  Table,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import { rpc } from '../../rpc';

// System + user skill checklist, grouped and checkable. Standalone and
// state-agnostic — `WizardSkillsStep` (the create-wizard tab) and
// `NewAgentDialog` (the rail-`+` fast path, P5) both wrap it around their
// own selection state rather than each rendering the catalog fetch and
// grouping themselves.
export function SkillsPicker({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (skillId: string) => void;
}) {
  const skillsQuery = useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => rpc.skills.list({}),
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
        description="No skills available. Create skills on the Skills page first."
      />
    );
  }

  const systemSkills = skills.filter((s) => s.source === 'system');
  const userSkills = skills.filter((s) => s.source !== 'system');
  const selectedSet = new Set(selected);

  const renderCheckbox = (s: Skill) => (
    <Checkbox key={s.id} checked={selectedSet.has(s.id)} onChange={() => onToggle(s.id)}>
      <span style={{ fontWeight: 500 }}>{s.name}</span>
      {s.description ? (
        <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
          {s.description}
        </Typography.Text>
      ) : null}
    </Checkbox>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Typography.Paragraph type="secondary">
        Select skills to attach from the library. Skills can also be added after creation.
      </Typography.Paragraph>
      {systemSkills.length > 0 ? (
        <>
          <Typography.Text strong>System</Typography.Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {systemSkills.map(renderCheckbox)}
          </div>
        </>
      ) : null}
      {userSkills.length > 0 ? (
        <>
          <Typography.Text strong style={systemSkills.length > 0 ? { marginTop: 12 } : {}}>
            My Skills
          </Typography.Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {userSkills.map(renderCheckbox)}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-personality skills panel
// ---------------------------------------------------------------------------

export function PersonalitySkillsPanel({ personalityId }: { personalityId: string }) {
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
                <div style={{ color: 'var(--ethos-text-dim)', fontSize: 11 }}>{s.id}.md</div>
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
    queryFn: () => rpc.skills.list({}),
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
