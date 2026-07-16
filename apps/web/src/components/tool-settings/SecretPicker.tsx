import {
  App as AntApp,
  Button,
  Divider,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useNamedSecretCreate } from '../../features/settings/api/mutations';
import { useNamedSecretsList } from '../../features/settings/api/queries';

// SecretPicker — a dropdown over global NAMED secrets, filtered by kind (and,
// when the consuming tool has a sibling provider, by that provider). Values
// never leave the vault; the picker only ever handles secret NAMES. An inline
// "Add secret" shortcut writes a new secret into the vault without leaving the
// form.
//
// v1: named secrets are web_search provider keys, so the add form offers the
// three search providers. When `providerFilter` is set, the add form locks to
// that provider so the created name aligns with the tool's chosen provider.

const WEB_SEARCH_PROVIDERS = ['exa', 'tavily', 'brave'] as const;
type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

function isWebSearchProvider(v: string | undefined): v is WebSearchProvider {
  return v === 'exa' || v === 'tavily' || v === 'brave';
}

export interface SecretPickerProps {
  /** Currently bound secret NAME, or undefined when unset. */
  value?: string;
  onChange: (name: string | undefined) => void;
  /** Category of named secret to offer (matches `settingsSchema` secretKind). */
  secretKind: string;
  /** Narrow the offered secrets to a single provider (the sibling enum value). */
  providerFilter?: string;
  disabled?: boolean;
}

export function SecretPicker({
  value,
  onChange,
  secretKind,
  providerFilter,
  disabled,
}: SecretPickerProps) {
  const secretsQuery = useNamedSecretsList();
  const [addOpen, setAddOpen] = useState(false);

  const secrets = (secretsQuery.data?.secrets ?? []).filter(
    (s) => s.kind === secretKind && (!providerFilter || s.provider === providerFilter),
  );

  const options = secrets.map((s) => ({
    value: s.name,
    label: (
      <Space size={8}>
        <span>{s.name}</span>
        <Typography.Text
          type="secondary"
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
        >
          {s.preview}
        </Typography.Text>
      </Space>
    ),
  }));

  return (
    <>
      <Select
        style={{ minWidth: 220, width: '100%' }}
        value={value ?? undefined}
        onChange={(v) => onChange(v || undefined)}
        options={options}
        placeholder={providerFilter ? `Select a ${providerFilter} key` : 'Select a secret'}
        loading={secretsQuery.isLoading}
        disabled={disabled}
        allowClear
        notFoundContent={
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            No secrets yet — add one below.
          </Typography.Text>
        }
        dropdownRender={(menu) => (
          <>
            {menu}
            <Divider style={{ margin: '4px 0' }} />
            <Button
              type="text"
              size="small"
              block
              style={{ textAlign: 'left' }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setAddOpen(true)}
            >
              + Add secret
            </Button>
          </>
        )}
      />
      {addOpen ? (
        <AddSecretModal
          initialProvider={isWebSearchProvider(providerFilter) ? providerFilter : undefined}
          lockProvider={isWebSearchProvider(providerFilter)}
          onClose={() => setAddOpen(false)}
          onCreated={(name) => {
            setAddOpen(false);
            onChange(name);
          }}
        />
      ) : null}
    </>
  );
}

interface AddSecretForm {
  provider: WebSearchProvider;
  name: string;
  value: string;
}

export function AddSecretModal({
  initialProvider,
  lockProvider,
  onClose,
  onCreated,
}: {
  initialProvider?: WebSearchProvider;
  lockProvider: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<AddSecretForm>();
  const createMut = useNamedSecretCreate();

  const handleSubmit = (values: AddSecretForm) => {
    createMut.mutate(
      { provider: values.provider, name: values.name.trim(), value: values.value },
      {
        onSuccess: () => {
          form.resetFields();
          onCreated(values.name.trim());
        },
        onError: (err) =>
          notification.error({
            message: 'Failed to add secret',
            description: (err as Error).message,
          }),
      },
    );
  };

  return (
    <Modal
      title="Add secret"
      open
      onCancel={onClose}
      okText="Save secret"
      confirmLoading={createMut.isPending}
      onOk={() => form.submit()}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        The value is stored in the local vault and never shown again — a personality references it
        by name only.
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{ provider: initialProvider ?? 'exa' }}
      >
        <Form.Item name="provider" label="Provider" rules={[{ required: true }]}>
          <Select
            disabled={lockProvider}
            options={WEB_SEARCH_PROVIDERS.map((p) => ({ value: p, label: p }))}
          />
        </Form.Item>
        <Form.Item
          name="name"
          label="Name"
          rules={[
            { required: true, message: 'Enter a name' },
            {
              pattern: /^[a-zA-Z0-9_-]+$/,
              message: 'Letters, digits, hyphens, underscores only',
            },
          ]}
        >
          <Input placeholder="e.g. main" autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="value"
          label="API key"
          rules={[{ required: true, message: 'Enter the key' }]}
        >
          <Input.Password placeholder="Paste the provider API key" autoComplete="off" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
