// The Add/Edit model drawer (plan/phases/model-registry.md T2.4, T2.8).
//
// Provider entry is a Select over the registry's own provider entries — an
// entry without an explicit id is listed, disabled, with the server's reason
// (D24). Model id is an AutoComplete over the catalog for that entry's
// provider TYPE, and free text survives: a hand-typed Ollama tag saves exactly
// as typed (D9). Test works as soon as provider and model id are filled, and
// probes the unsaved `(providerKey, modelId)` pair — testing before saving is
// the point of this button (D19.1).

import type {
  ModelRegistryListResult,
  ModelRegistryRefusal,
  ModelRegistryTestResult,
  ModelRegistryUpsertRequest,
} from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { AutoComplete, Button, Drawer, Input, InputNumber, Select } from 'antd';
import { type CSSProperties, useId, useState } from 'react';
import { ModelTestOutcome } from '../../../components/models/ModelTestOutcome';
import { rpc } from '../../../rpc';
import {
  catalogSuggestions,
  draftSavable,
  draftTestable,
  formatContextWindow,
  type ModelDraft,
  modelCatalogKey,
  pickCatalogModel,
  providerTypeOf,
  testButtonState,
  testedAtFor,
  testSubjectKey,
  upsertRequest,
} from '../lib/model-registry';
import { recordModelTest, useCooldownClock, useModelTestLog } from '../lib/model-test-log';
import { MONO, messageOf, RefusalNotice, SUB, TestButton } from './model-registry-notices';

const ROW: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 };
const LABEL: CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' };
const PAIR: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 10,
};
const OPTION: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  alignItems: 'baseline',
};
const HINT: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)' };

export function ModelDrawer({
  mode,
  initial,
  list,
  providerLocked = false,
  onClose,
  onSaved,
}: {
  mode: ModelRegistryUpsertRequest['mode'];
  initial: ModelDraft;
  list: ModelRegistryListResult;
  /** "+ Add model to <provider>": `initial.provider` is chosen and cannot be changed. */
  providerLocked?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ids = useId();
  const catalogQuery = useQuery({
    queryKey: modelCatalogKey(),
    queryFn: () => rpc.models.catalog(),
  });
  const log = useModelTestLog();
  const now = useCooldownClock(log.testedAt);
  const [draft, setDraft] = useState<ModelDraft>(initial);
  const [fromCatalog, setFromCatalog] = useState(false);
  const [outcome, setOutcome] = useState<ModelRegistryTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<ModelRegistryRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const providerType = providerTypeOf(list, draft.provider);
  const suggestions = catalogSuggestions(catalogQuery.data, providerType);
  const entry = list.providerEntries.find((e) => e.key === draft.provider);
  const subject = { providerKey: draft.provider.trim(), modelId: draft.modelId.trim() };
  const testState = testButtonState({
    credential: entry?.credential ?? null,
    providerKey: draft.provider,
    ready: draftTestable(draft),
    testedAt: log.testedAt[testSubjectKey(subject)],
    now,
  });
  const noReferenceable = !list.providerEntries.some((e) => e.referenceable);

  /** The pair under test changed, so the last outcome no longer describes it. */
  function setSubject(patch: Partial<Pick<ModelDraft, 'provider' | 'modelId'>>) {
    setDraft((d) => ({ ...d, ...patch }));
    setOutcome(null);
  }

  async function runTest() {
    setTesting(true);
    setError(null);
    try {
      const result = await rpc.modelRegistry.test(subject);
      setOutcome(result);
      recordModelTest({
        subjectKeys: [testSubjectKey(subject)],
        testedAt: testedAtFor(result, Date.now()),
      });
    } catch (err) {
      setError(`The test could not run: ${messageOf(err)}`);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setRefusal(null);
    setError(null);
    try {
      const result = await rpc.modelRegistry.upsert(upsertRequest(draft, mode));
      if (result.ok) onSaved();
      else setRefusal(result);
    } catch (err) {
      setError(`Could not save: ${messageOf(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open
      title={mode === 'create' ? 'Add model' : 'Edit model'}
      onClose={onClose}
      width={480}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            loading={saving}
            disabled={!draftSavable(draft)}
            onClick={() => void save()}
          >
            Save model
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={ROW}>
          <label htmlFor={`${ids}-alias`} style={LABEL}>
            Alias
          </label>
          <Input
            id={`${ids}-alias`}
            value={draft.alias}
            disabled={mode === 'update'}
            placeholder="e.g. sonnet"
            style={MONO}
            onChange={(e) => setDraft((d) => ({ ...d, alias: e.target.value }))}
          />
          <span style={HINT}>
            {mode === 'update' ? (
              "An alias can't be renamed. To rename, add a new model, then remove this one and repoint what uses it."
            ) : (
              <>
                What personalities and roles refer to. Can't be <span style={MONO}>trivial</span>,{' '}
                <span style={MONO}>default</span>, <span style={MONO}>deep</span> or{' '}
                <span style={MONO}>dreaming</span>.
              </>
            )}
          </span>
        </div>

        <div style={ROW}>
          <label htmlFor={`${ids}-provider`} style={LABEL}>
            Provider entry
          </label>
          <Select
            id={`${ids}-provider`}
            value={draft.provider || undefined}
            disabled={providerLocked}
            placeholder="Choose a provider entry"
            onChange={(value: string) => setSubject({ provider: value })}
            options={list.providerEntries.map((e) => ({
              value: e.key,
              disabled: !e.referenceable,
              label: (
                <span style={OPTION}>
                  <span style={MONO}>{e.key}</span>
                  <span style={e.referenceable ? HINT : { ...HINT, color: 'var(--warning)' }}>
                    {e.referenceable ? e.provider : (e.reason ?? 'this provider has no id yet')}
                  </span>
                </span>
              ),
            }))}
          />
          {providerLocked ? (
            <span style={HINT}>Adding a model to this provider.</span>
          ) : noReferenceable ? (
            <span style={HINT}>No provider has an id yet. Add a provider first.</span>
          ) : null}
        </div>

        <div style={ROW}>
          <label htmlFor={`${ids}-model`} style={LABEL}>
            Model id
          </label>
          <AutoComplete
            id={`${ids}-model`}
            value={draft.modelId}
            placeholder={
              providerType === 'ollama' ? 'e.g. qwen2.5-coder:32b' : 'e.g. claude-sonnet-5'
            }
            style={MONO}
            options={
              suggestions.length > 0
                ? [
                    {
                      label: `From the catalog · ${providerType ?? ''}`,
                      options: suggestions.map((s) => ({
                        value: s.value,
                        label: (
                          <span style={OPTION}>
                            <span style={MONO}>{s.value}</span>
                            <span style={HINT}>{formatContextWindow(s.contextWindow)}</span>
                          </span>
                        ),
                      })),
                    },
                  ]
                : []
            }
            filterOption={(input, option) =>
              option !== undefined &&
              'value' in option &&
              typeof option.value === 'string' &&
              option.value.toLowerCase().includes(input.trim().toLowerCase())
            }
            onChange={(value: string) => setSubject({ modelId: value })}
            onSelect={(value: string) => {
              const hit = suggestions.find((s) => s.value === value);
              if (!hit) return;
              setDraft((d) => pickCatalogModel(d, hit));
              setOutcome(null);
              setFromCatalog(true);
            }}
          />
          <span style={HINT}>Any id the provider serves — the catalog only suggests.</span>
        </div>

        <div style={ROW}>
          <label htmlFor={`${ids}-label`} style={LABEL}>
            Label
          </label>
          <Input
            id={`${ids}-label`}
            value={draft.label}
            placeholder="e.g. everyday driver"
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          />
        </div>

        <div style={PAIR}>
          <div style={ROW}>
            <label htmlFor={`${ids}-context`} style={LABEL}>
              Context window
            </label>
            <InputNumber
              id={`${ids}-context`}
              value={draft.contextWindow}
              min={1}
              precision={0}
              style={{ ...MONO, width: '100%' }}
              onChange={(v) => {
                setDraft((d) => ({ ...d, contextWindow: typeof v === 'number' ? v : null }));
                setFromCatalog(false);
              }}
            />
            {fromCatalog ? <span style={HINT}>From the catalog</span> : null}
          </div>
          <div style={ROW}>
            <span style={LABEL}>Cost / 1K in · out</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <InputNumber
                aria-label="Cost per 1K input tokens"
                value={draft.costPer1kInput}
                min={0}
                style={{ ...MONO, width: '100%' }}
                onChange={(v) =>
                  setDraft((d) => ({ ...d, costPer1kInput: typeof v === 'number' ? v : null }))
                }
              />
              <span style={HINT}>·</span>
              <InputNumber
                aria-label="Cost per 1K output tokens"
                value={draft.costPer1kOutput}
                min={0}
                style={{ ...MONO, width: '100%' }}
                onChange={(v) =>
                  setDraft((d) => ({ ...d, costPer1kOutput: typeof v === 'number' ? v : null }))
                }
              />
            </div>
          </div>
        </div>

        <div style={ROW}>
          <div>
            <TestButton state={testState} loading={testing} onClick={() => void runTest()} />
          </div>
          {outcome ? <ModelTestOutcome outcome={outcome} /> : null}
        </div>

        {refusal ? <RefusalNotice refusal={refusal} /> : null}
        {error ? (
          <span role="alert" style={{ fontSize: 13 }}>
            <span style={{ color: 'var(--error)' }}>✗ </span>
            {error}
          </span>
        ) : null}
        <span style={SUB}>Saved to config.yaml as soon as you choose Save model.</span>
      </div>
    </Drawer>
  );
}
