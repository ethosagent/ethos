// The Edit provider drawer (approved "Providers & models" mockup, decision 4):
// replace a provider's key, base URL, and the type-specific lines (azure's
// `apiVersion`, bedrock's `region` / `awsProfile` — `providerExtraFields`)
// through `modelRegistry.updateProvider`, or remove it through
// `modelRegistry.removeProvider`. The id is shown and never editable — models
// name it (D24).
//
// Both save on confirm. A refusal is a value rendered here; `removeProvider`
// while models still use the provider is refused, and the refusal's `aliases`
// are listed so the operator knows which models to move or remove first.
//
// The stored base URL and key preview come from a `config.get` read keyed
// under `['modelRegistry', …]`, so it refreshes with every registry write and
// never touches the page's own `['config']` query — refetching THAT would
// re-hydrate the form and wipe unsaved edits in other sections.
//
// The `apiVersion` / `region` / `awsProfile` fields start as the entry's stored
// lines (`list.providerEntries`). One whose value is unchanged is omitted from
// the write (the line is kept); one cleared sends `''`, which removes the line
// (`ModelRegistryUpdateProviderInput`).

import type {
  ModelProviderEntryView,
  ModelRegistryProviderRefusal,
} from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { App as AntApp, Button, Drawer, Input } from 'antd';
import { type CSSProperties, useEffect, useId, useState } from 'react';
import { rpc } from '../../../rpc';
import { modelRegistryKeys } from '../lib/model-registry';
import {
  catalogEntryFor,
  type ProviderExtraField,
  providerExtraFields,
} from '../lib/providers-and-models';
import { MONO, messageOf, RefusalNotice } from './model-registry-notices';

const ROW: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 };
const LABEL: CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' };
const HINT: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)' };

export function EditProviderDrawer({
  entry,
  onClose,
  onSaved,
  onRemoved,
}: {
  entry: ModelProviderEntryView;
  onClose: () => void;
  onSaved: () => void;
  onRemoved: () => void;
}) {
  const ids = useId();
  const { modal } = AntApp.useApp();
  const storedQuery = useQuery({
    queryKey: [...modelRegistryKeys.all(), 'providerConfig'],
    queryFn: () => rpc.config.get(),
  });
  const stored =
    storedQuery.data?.providers.find((p) => entry.id !== null && p.id === entry.id) ??
    storedQuery.data?.providers[entry.index];
  const storedBaseUrl = stored?.baseUrl ?? '';
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  /** The stored lines; '' = the entry has no such line. */
  const storedExtras: Record<ProviderExtraField, string> = {
    apiVersion: entry.apiVersion ?? '',
    region: entry.region ?? '',
    awsProfile: entry.awsProfile ?? '',
  };
  const [extras, setExtras] = useState<Record<ProviderExtraField, string>>(storedExtras);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [refusal, setRefusal] = useState<ModelRegistryProviderRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The field starts as what is stored, once that has been read.
  useEffect(() => {
    if (storedQuery.data && baseUrl === null) setBaseUrl(storedBaseUrl);
  }, [storedQuery.data, storedBaseUrl, baseUrl]);

  const authType = catalogEntryFor(entry.provider)?.authType ?? null;
  const showKey = authType === 'api-key' || entry.credential !== 'not_needed';
  // Bedrock reads no base URL (`bedrockFactory`, extensions/llm-bedrock).
  const showBaseUrl = authType !== 'device-auth' && authType !== 'aws-credentials';
  const extraFields = providerExtraFields(entry.provider);
  const baseUrlChanged = baseUrl !== null && baseUrl.trim() !== storedBaseUrl;
  /** Only the fields whose value differs from the stored line. */
  const extraEdits: Partial<Record<ProviderExtraField, string>> = {};
  for (const { field } of extraFields) {
    const value = extras[field].trim();
    if (value !== storedExtras[field]) extraEdits[field] = value;
  }
  const changed = apiKey.trim() !== '' || baseUrlChanged || Object.keys(extraEdits).length > 0;

  async function save() {
    setSaving(true);
    setRefusal(null);
    setError(null);
    try {
      const result = await rpc.modelRegistry.updateProvider({
        key: entry.key,
        // A blank key is omitted, and the stored key is kept.
        ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
        // `''` removes the line (`ModelRegistryUpdateProviderInput`).
        ...(baseUrlChanged && baseUrl !== null ? { baseUrl: baseUrl.trim() } : {}),
        ...extraEdits,
      });
      if (result.ok) onSaved();
      else setRefusal(result);
    } catch (err) {
      setError(`Could not save: ${messageOf(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setRemoving(true);
    setRefusal(null);
    setError(null);
    try {
      const result = await rpc.modelRegistry.removeProvider({ key: entry.key });
      if (result.ok) onRemoved();
      else setRefusal(result);
    } catch (err) {
      setError(`Could not remove ${entry.key}: ${messageOf(err)}`);
    } finally {
      setRemoving(false);
    }
  }

  function confirmRemove() {
    modal.confirm({
      title: `Remove ${entry.key}?`,
      content: 'Its entry is deleted from the provider chain in config.yaml.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: () => remove(),
    });
  }

  return (
    <Drawer
      open
      className="edit-provider-drawer"
      title="Edit provider"
      onClose={onClose}
      width={480}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <Button danger loading={removing} onClick={confirmRemove}>
            Remove provider
          </Button>
          <span style={{ display: 'flex', gap: 8 }}>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="primary" loading={saving} disabled={!changed} onClick={() => void save()}>
              Save provider
            </Button>
          </span>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={ROW}>
          <label htmlFor={`${ids}-id`} style={LABEL}>
            Id
          </label>
          <Input id={`${ids}-id`} value={entry.key} disabled style={MONO} />
          <span style={HINT}>
            {entry.provider} · can't be changed, because models name it as their provider.
          </span>
        </div>

        {showKey ? (
          <div style={ROW}>
            <label htmlFor={`${ids}-key`} style={LABEL}>
              API key
            </label>
            <Input.Password
              id={`${ids}-key`}
              autoComplete="off"
              value={apiKey}
              placeholder={stored?.apiKeyPreview || 'paste a new key'}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <span style={HINT}>
              {stored?.apiKeyPreview
                ? `Current: ${stored.apiKeyPreview}. Leave blank to keep it.`
                : 'Leave blank to keep the stored key.'}
            </span>
          </div>
        ) : null}

        {showBaseUrl ? (
          <div style={ROW}>
            <label htmlFor={`${ids}-base`} style={LABEL}>
              Base URL
            </label>
            <Input
              id={`${ids}-base`}
              value={baseUrl ?? ''}
              style={MONO}
              placeholder={catalogEntryFor(entry.provider)?.baseUrl?.default ?? 'provider default'}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <span style={HINT}>Empty uses the provider's default.</span>
          </div>
        ) : null}

        {extraFields.map((spec) => (
          <div key={spec.field} style={ROW}>
            <label htmlFor={`${ids}-${spec.field}`} style={LABEL}>
              {spec.label}
            </label>
            <Input
              id={`${ids}-${spec.field}`}
              value={extras[spec.field]}
              style={MONO}
              placeholder={spec.placeholder}
              onChange={(e) => setExtras((x) => ({ ...x, [spec.field]: e.target.value }))}
            />
            <span style={HINT}>
              {extras[spec.field].trim() === '' && storedExtras[spec.field] !== ''
                ? 'Saving removes this line from config.yaml.'
                : spec.hint}
            </span>
          </div>
        ))}

        {refusal ? (
          <div className="provider-refusal">
            <RefusalNotice refusal={refusal} />
            {refusal.aliases.length > 0 ? (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                {refusal.aliases.map((alias) => (
                  <li key={alias} style={MONO}>
                    {alias}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <span role="alert" style={{ fontSize: 13 }}>
            <span style={{ color: 'var(--error)' }}>✗ </span>
            {error}
          </span>
        ) : null}
        <span style={HINT}>
          Saved to config.yaml as soon as you confirm. Keys go to the secret store.
        </span>
      </div>
    </Drawer>
  );
}
