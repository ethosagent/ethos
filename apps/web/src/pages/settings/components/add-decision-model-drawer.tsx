// The Add decision model drawer — the decision-model counterpart of
// ./add-provider-drawer, in one step: choose a type, paste its key, Add.
//
// `types` is what the section hands in: the server's catalog
// (`DECISION_PROVIDER_CATALOG`, apps/web-api services/decision-catalog.ts)
// minus the types already in the list (`addableDecisionTypes`,
// ../lib/decision-models). Each is a row with its description and a link to
// get a key, so a second provider appears here with no change to this file.
//
// "Add decision model" is ONE `decisions.setKey` call: it stores the key and
// writes `decisions.provider` only when that line is absent — never a site
// (`DecisionsService.setKey`, apps/web-api). A failure is rendered inline and
// the drawer stays open.

import type { DecisionProviderType } from '@ethosagent/web-contracts';
import { Button, Drawer, Input, Radio } from 'antd';
import { type CSSProperties, useId, useState } from 'react';
import { rpc } from '../../../rpc';
import { MONO, messageOf } from './model-registry-notices';

const ROW: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 };
const LABEL: CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' };
const HINT: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)' };
const TYPE_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '8px 0',
  borderBottom: '1px solid var(--border-subtle)',
};

export function AddDecisionModelDrawer({
  types,
  onClose,
  onAdded,
}: {
  /** Catalog types not yet in the list. */
  types: readonly DecisionProviderType[];
  onClose: () => void;
  onAdded: (type: DecisionProviderType, providerWritten: boolean) => void;
}) {
  const [typeId, setTypeId] = useState<DecisionProviderType['id'] | undefined>(types[0]?.id);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const type = types.find((t) => t.id === typeId);

  async function save() {
    if (!type) return;
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.decisions.setKey({ providerId: type.id, value: apiKey.trim() });
      onAdded(type, result.providerWritten);
    } catch (err) {
      setError(`Could not add ${type.label}: ${messageOf(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open
      className="add-decision-model-drawer"
      title="Add decision model"
      onClose={onClose}
      width={480}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            loading={saving}
            disabled={!type || apiKey.trim() === ''}
            onClick={() => void save()}
          >
            Add decision model
          </Button>
        </div>
      }
    >
      <AddDecisionModelForm
        types={types}
        typeId={typeId}
        onType={setTypeId}
        apiKey={apiKey}
        onApiKey={setApiKey}
        error={error}
      />
    </Drawer>
  );
}

/** The drawer's body, apart from the portal so it renders in a test. */
export function AddDecisionModelForm({
  types,
  typeId,
  onType,
  apiKey,
  onApiKey,
  error,
}: {
  types: readonly DecisionProviderType[];
  typeId: DecisionProviderType['id'] | undefined;
  onType: (id: DecisionProviderType['id']) => void;
  apiKey: string;
  onApiKey: (value: string) => void;
  error: string | null;
}) {
  const ids = useId();
  const type = types.find((t) => t.id === typeId);
  if (types.length === 0) {
    return <span style={HINT}>Every decision model type is already added.</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={ROW}>
        <span style={LABEL}>Type</span>
        <Radio.Group
          value={typeId}
          onChange={(e) => {
            const picked = types.find((t) => t.id === e.target.value);
            if (picked) onType(picked.id);
          }}
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          {types.map((t) => (
            <div key={t.id} className="add-decision-model-type" style={TYPE_ROW}>
              <Radio value={t.id} aria-label={`${t.label} by ${t.vendor}`} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 13 }}>
                  <span style={{ fontWeight: 500 }}>{t.label}</span>{' '}
                  <span style={HINT}>by {t.vendor}</span>
                </span>
                <span style={HINT}>{t.description}</span>
                <span style={HINT}>
                  Model <span style={MONO}>{t.defaultModel}</span> at{' '}
                  <span style={MONO}>{t.defaultBaseUrl}</span> ·{' '}
                  <a href={t.getKeyUrl} target="_blank" rel="noopener noreferrer">
                    Get a key
                  </a>
                </span>
              </div>
            </div>
          ))}
        </Radio.Group>
      </div>

      {type ? (
        <div style={ROW}>
          <label htmlFor={`${ids}-key`} style={LABEL}>
            {type.vendor} API key
          </label>
          <Input.Password
            id={`${ids}-key`}
            autoComplete="off"
            value={apiKey}
            onChange={(e) => onApiKey(e.target.value)}
          />
          <span style={HINT}>
            Stored in the secret store at <span style={MONO}>{type.keyRef}</span>, not in
            config.yaml. Adding writes <span style={MONO}>decisions.provider: {type.id}</span> when
            no decision model is active. It never turns a site on; any{' '}
            <span style={MONO}>decisions.sites.*</span> lines already in config.yaml apply as
            written.
          </span>
        </div>
      ) : null}

      {error ? (
        <span role="alert" style={{ fontSize: 13 }}>
          <span style={{ color: 'var(--error)' }}>✗ </span>
          {error}
        </span>
      ) : null}
    </div>
  );
}
