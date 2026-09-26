// Logins — stored credentials for `browser_fill_credential` (plan
// reach-and-containment §4.2), rendered in Settings › Security below named
// secrets.
//
// Values are WRITE-ONLY from here: the list shows the masked username preview
// the server computes (`redactSecretValue`) and presence flags, never a value,
// and the edit form never pre-fills username, password or TOTP — a blank field
// keeps what is stored. Validation (bare https origins, loopback-only http,
// personality ids, TOTP seeds) is the server's (`CredentialsService` →
// `credential-vault.ts`); a refusal comes back as the notification text.
//
// Lives outside `pages/settings/panes/` on purpose: the settings-index
// coverage test scans every `name=` in that directory as a page-form control,
// and this modal's fields are not page-form controls.

import {
  App as AntApp,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { usePersonalityList } from '../../features/personalities/api/queries';
import { useCredentialDelete, useCredentialSet } from '../../features/settings/api/mutations';
import { useCredentialsList } from '../../features/settings/api/queries';
import { SelfSaveMarker } from '../../pages/settings/components/self-save-marker';
import type { rpc } from '../../rpc';

type CredentialRow = Awaited<ReturnType<typeof rpc.credentials.list>>['credentials'][number];

interface LoginForm {
  name: string;
  username?: string;
  password?: string;
  totp?: string;
  clearTotp?: boolean;
  origins: string[];
  personalities: string[];
  unattended: boolean;
}

const MONO = { fontFamily: 'Geist Mono, monospace', fontSize: 12 } as const;

export function LoginsSection() {
  const listQuery = useCredentialsList();
  const deleteMut = useCredentialDelete();
  const { modal } = AntApp.useApp();
  // `null` = closed, `'new'` = add, a row = edit that login.
  const [editing, setEditing] = useState<CredentialRow | 'new' | null>(null);

  const handleDelete = (row: CredentialRow) => {
    modal.confirm({
      title: 'Delete login',
      content: `Delete "${row.name}"? Its username, password, TOTP seed and grants are removed from the vault.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: () => deleteMut.mutate({ name: row.name }),
    });
  };

  const columns: ColumnsType<CredentialRow> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row) => (
        <Space size={4}>
          <Typography.Text style={MONO}>{name}</Typography.Text>
          {row.policyValid ? null : <Tag color="error">invalid policy</Tag>}
        </Space>
      ),
    },
    {
      title: 'Origins',
      dataIndex: 'origins',
      key: 'origins',
      render: (origins: string[]) => (
        <Space direction="vertical" size={0}>
          {origins.map((o) => (
            <Typography.Text key={o} style={MONO}>
              {o}
            </Typography.Text>
          ))}
        </Space>
      ),
    },
    {
      title: 'Personalities',
      dataIndex: 'personalities',
      key: 'personalities',
      render: (ids: string[]) =>
        ids.length === 0 ? (
          <Typography.Text type="secondary">nobody</Typography.Text>
        ) : (
          ids.map((id) => (
            <Tag key={id} style={{ margin: '0 4px 4px 0' }}>
              {id}
            </Tag>
          ))
        ),
    },
    {
      title: 'Username',
      dataIndex: 'usernamePreview',
      key: 'usernamePreview',
      render: (preview: string) => (
        <Typography.Text type="secondary" style={MONO}>
          {preview}
        </Typography.Text>
      ),
    },
    {
      title: 'TOTP',
      dataIndex: 'hasTotp',
      key: 'hasTotp',
      render: (has: boolean) => (has ? '✓' : '–'),
    },
    {
      title: 'Unattended',
      dataIndex: 'unattended',
      key: 'unattended',
      render: (on: boolean) => (on ? 'allowed' : 'refused'),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, row: CredentialRow) => (
        <Space size={4}>
          <Button size="small" onClick={() => setEditing(row)}>
            Edit
          </Button>
          <Button
            size="small"
            danger
            onClick={() => handleDelete(row)}
            loading={deleteMut.isPending}
          >
            Delete
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 'var(--layout-chat-max-width)', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <Typography.Paragraph type="secondary" style={{ margin: 0, flex: 1 }}>
          Logins <Typography.Text code>browser_fill_credential</Typography.Text> can fill without
          the model seeing them. Each is bound to exact origins and to the personalities listed — a
          personality needs both the tool in its toolset and a grant here.
        </Typography.Paragraph>
        <Button size="small" onClick={() => setEditing('new')}>
          Add login
        </Button>
      </div>
      <SelfSaveMarker />
      <Table
        size="small"
        rowKey="name"
        columns={columns}
        dataSource={listQuery.data?.credentials ?? []}
        loading={listQuery.isLoading}
        pagination={false}
        locale={{
          emptyText: (
            <span>
              No logins stored. Add one here or with{' '}
              <Typography.Text code>ethos secrets credential add</Typography.Text>.
            </span>
          ),
        }}
      />
      {editing ? (
        <LoginModal
          existing={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function LoginModal({ existing, onClose }: { existing?: CredentialRow; onClose: () => void }) {
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<LoginForm>();
  const setMut = useCredentialSet();
  const personalitiesQuery = usePersonalityList();
  const isEdit = existing !== undefined;

  const handleSubmit = (values: LoginForm) => {
    // Blank = keep what is stored (edit) — a value never round-trips back here
    // to be re-submitted.
    const username = values.username?.trim() ? values.username.trim() : undefined;
    const password = values.password ? values.password : undefined;
    const totp = values.clearTotp ? null : values.totp?.trim() ? values.totp.trim() : undefined;
    setMut.mutate(
      {
        name: values.name.trim(),
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(totp !== undefined ? { totp } : {}),
        origins: values.origins,
        personalities: values.personalities ?? [],
        unattended: values.unattended === true,
      },
      {
        onSuccess: () => {
          form.resetFields();
          notification.success({ message: 'Login saved', placement: 'topRight' });
          onClose();
        },
        onError: (err) =>
          notification.error({
            message: 'Failed to save login',
            description: (err as Error).message,
          }),
      },
    );
  };

  return (
    <Modal
      title={isEdit ? `Edit login — ${existing.name}` : 'Add login'}
      open
      onCancel={onClose}
      okText="Save login"
      confirmLoading={setMut.isPending}
      onOk={() => form.submit()}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Values are stored in the local vault and never shown again.
        {isEdit ? ' Leave a field blank to keep what is stored.' : ''}
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          name: existing?.name,
          origins: existing?.origins ?? [],
          personalities: existing?.personalities ?? [],
          unattended: existing?.unattended ?? false,
        }}
      >
        <Form.Item
          name="name"
          label="Name"
          rules={[
            { required: true, message: 'Enter a name' },
            { pattern: /^[a-zA-Z0-9_-]+$/, message: 'Letters, digits, hyphens, underscores only' },
          ]}
        >
          <Input placeholder="e.g. github-work" autoComplete="off" disabled={isEdit} />
        </Form.Item>
        <Form.Item
          name="username"
          label="Username"
          rules={isEdit ? [] : [{ required: true, message: 'Enter the username' }]}
        >
          <Input autoComplete="off" placeholder={isEdit ? existing.usernamePreview : undefined} />
        </Form.Item>
        <Form.Item
          name="password"
          label="Password"
          rules={isEdit ? [] : [{ required: true, message: 'Enter the password' }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="totp"
          label="TOTP seed"
          extra="Optional. A base32 key or an otpauth://totp/ URI — used to fill 2FA codes."
        >
          <Input.Password
            autoComplete="off"
            placeholder={isEdit && existing.hasTotp ? 'stored — blank keeps it' : undefined}
          />
        </Form.Item>
        {isEdit && existing.hasTotp ? (
          <Form.Item name="clearTotp" valuePropName="checked" style={{ marginTop: -8 }}>
            <Checkbox>Remove the stored TOTP seed</Checkbox>
          </Form.Item>
        ) : null}
        <Form.Item
          name="origins"
          label="Origins"
          extra="Exact origins, e.g. https://github.com. https only; http is allowed for localhost."
          rules={[{ required: true, message: 'Add at least one origin' }]}
        >
          <Select mode="tags" tokenSeparators={[' ', ',']} placeholder="https://example.com" />
        </Form.Item>
        <Form.Item
          name="personalities"
          label="Personalities"
          extra="Only these may use the login. None = nobody."
        >
          <Select
            mode="tags"
            loading={personalitiesQuery.isLoading}
            options={(personalitiesQuery.data?.items ?? []).map((p) => ({
              value: p.id,
              label: p.id,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="unattended"
          label="Allow unattended fills"
          valuePropName="checked"
          extra="Background jobs and surfaces nobody is watching are refused unless this is on."
        >
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}
