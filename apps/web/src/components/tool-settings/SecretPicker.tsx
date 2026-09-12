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
import { useNamedSecretProviders, useNamedSecretsList } from '../../features/settings/api/queries';
import type { rpc } from '../../rpc';

// SecretPicker — a dropdown over global NAMED secrets, filtered by kind (and,
// when the consuming tool has a sibling provider, by that provider). Values
// never leave the vault; the picker only ever handles secret NAMES. An inline
// "Add secret" shortcut writes a new secret into the vault without leaving the
// form.
//
// The add form offers every provider the vault accepts, grouped by kind. When
// `providerFilter` names one of them the form locks to it; otherwise, when the
// picker's `secretKind` maps to exactly one provider (x_search → xai), it locks
// to that one, so the created secret always lands where the tool will look.
//
// That roster is SERVER-derived (`namedSecrets.providers`) from the registered
// tools' `providers/<segment>/*` capability grants. Nothing here restates it:
// a tool — including a plugin's — brings its own provider with it, and this
// file needs no edit for it (plan/phases/tool-credential-surface.md D1).

type ProviderRow = Awaited<ReturnType<typeof rpc.namedSecrets.providers>>['providers'][number];

/** The providers whose secrets a picker of `secretKind` offers. A provider can
 *  declare several kinds (two tools, one namespace), so this is a membership
 *  test over `kinds`, not an equality test on one. */
export function providersOfKind(roster: ProviderRow[], secretKind: string): string[] {
  return roster.filter((p) => p.kinds.includes(secretKind)).map((p) => p.provider);
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
  const providersQuery = useNamedSecretProviders();
  const [addOpen, setAddOpen] = useState(false);
  const roster = providersQuery.data?.providers ?? [];
  const rosterLoading = providersQuery.isLoading || providersQuery.isPending;
  const filterProvider = roster.some((p) => p.provider === providerFilter)
    ? providerFilter
    : undefined;
  const kindProviders = providersOfKind(roster, secretKind);

  // While the roster loads, `kindProviders` is empty and would wipe the Select
  // options (and hide a currently-bound value). Defer the kind filter until
  // the roster arrives; still honour an explicit providerFilter, and keep the
  // bound value visible as a fallback option.
  const secrets = (secretsQuery.data?.secrets ?? []).filter((s) => {
    if (providerFilter && s.provider !== providerFilter) return false;
    if (rosterLoading) return true;
    return kindProviders.includes(s.provider);
  });

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
  // Bound value may not be in the filtered list yet (roster still loading, or
  // kind mismatch until providers arrive) — keep it selectable so the control
  // does not flash empty.
  if (value && !options.some((o) => o.value === value)) {
    options.unshift({
      value,
      label: <span>{value}</span>,
    });
  }

  return (
    <>
      <Select
        style={{ minWidth: 220, width: '100%' }}
        value={value ?? undefined}
        onChange={(v) => onChange(v || undefined)}
        options={options}
        placeholder={providerFilter ? `Select a ${providerFilter} key` : 'Select a secret'}
        loading={secretsQuery.isLoading || rosterLoading}
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
          initialProvider={
            filterProvider ?? (kindProviders.length === 1 ? kindProviders[0] : undefined)
          }
          lockProvider={filterProvider !== undefined || kindProviders.length === 1}
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
  provider: string;
  name: string;
  value: string;
}

export function AddSecretModal({
  initialProvider,
  lockProvider,
  onClose,
  onCreated,
  onSubmit,
  title = 'Add secret',
  okText = 'Save secret',
}: {
  initialProvider?: string;
  lockProvider: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
  /**
   * When set, replaces the default create-only path. Caller owns the write
   * (e.g. create-and-bind on the personality page). Must resolve on success.
   */
  onSubmit?: (values: { provider: string; name: string; value: string }) => Promise<void>;
  title?: string;
  okText?: string;
}) {
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<AddSecretForm>();
  const createMut = useNamedSecretCreate();
  const [submitting, setSubmitting] = useState(false);
  const providersQuery = useNamedSecretProviders();
  const roster = providersQuery.data?.providers ?? [];
  const selectedProvider = Form.useWatch('provider', form) ?? initialProvider;
  const getKeyUrl = roster.find((p) => p.provider === selectedProvider)?.getKeyUrl;

  const handleSubmit = (values: AddSecretForm) => {
    const payload = {
      provider: values.provider,
      name: values.name.trim(),
      value: values.value,
    };
    if (onSubmit) {
      setSubmitting(true);
      void onSubmit(payload)
        .then(() => {
          form.resetFields();
          onCreated(payload.name);
        })
        .catch((err: unknown) =>
          notification.error({
            message: 'Failed to add secret',
            description: (err as Error).message,
          }),
        )
        .finally(() => setSubmitting(false));
      return;
    }
    createMut.mutate(payload, {
      onSuccess: () => {
        form.resetFields();
        onCreated(payload.name);
      },
      onError: (err) =>
        notification.error({
          message: 'Failed to add secret',
          description: (err as Error).message,
        }),
    });
  };

  return (
    <Modal
      title={title}
      open
      onCancel={onClose}
      okText={okText}
      confirmLoading={onSubmit ? submitting : createMut.isPending}
      onOk={() => form.submit()}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        The value is stored in the local vault and never shown again — a personality references it
        by name only.
      </Typography.Paragraph>
      {!providersQuery.isLoading && roster.length === 0 ? (
        <Typography.Paragraph type="secondary">
          No tool declaring a credential namespace is registered yet, so there is nothing to add a
          key for. Start a chat so the tool registry boots, then reopen this — or set the key
          directly with <Typography.Text code>ethos secrets set</Typography.Text>.
        </Typography.Paragraph>
      ) : null}
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{ provider: initialProvider }}
      >
        <Form.Item name="provider" label="Provider" rules={[{ required: true }]}>
          <Select
            disabled={lockProvider}
            loading={providersQuery.isLoading}
            placeholder="Select a provider"
            options={roster.map((p) => ({ value: p.provider, label: p.label }))}
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
          {...(getKeyUrl
            ? {
                extra: (
                  <Typography.Link href={getKeyUrl} target="_blank" rel="noreferrer">
                    Where to get this key
                  </Typography.Link>
                ),
              }
            : {})}
        >
          <Input.Password placeholder="Paste the provider API key" autoComplete="off" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
