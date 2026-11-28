import type { Skill } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Form, Input, Modal, Spin } from 'antd';
import { useEffect } from 'react';
import { rpc } from '../../rpc';

// The Skills page's create and edit dialogs, split out of `pages/Skills.tsx`
// (a size-baselined file) unchanged.

export function CreateSkillModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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

export function EditSkillModal({ skill, onClose }: { skill: Skill; onClose: () => void }) {
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
