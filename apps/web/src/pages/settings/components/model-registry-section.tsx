// Settings → Models › providers & models — ONE list, grouped by provider in
// chain order, each provider with its models beneath it (the approved
// "Providers & models" mockup; plan/phases/model-registry.md T2.3, T2.4, T2.8,
// T2.12). Below it, the role bindings.
//
// Every write here saves immediately through `modelRegistry.*` as one
// config.yaml write — none of it goes through the page's Save bar — and every
// write answers `{ ok: true, … } | refusal`, rendered in place. The registry is
// refetched after each write, refused or not, so the list is always what the
// file now says. Only `['modelRegistry']` is invalidated: the page's
// `['config']` query re-hydrates the form, which would wipe unsaved edits in
// other sections.

import type {
  ModelProviderEntryView,
  ModelReferent,
  ModelRegistryEntryView,
  ModelRegistryImportChainResult,
  ModelRegistryProviderWriteResult,
  ModelRegistryRefusal,
  ModelRegistryWriteResult,
} from '@ethosagent/web-contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Radio, Select, Spin, Tooltip, Typography } from 'antd';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { rpc } from '../../../rpc';
import {
  BINDABLE_ROLES,
  type BindableRole,
  cooldownSeconds,
  defaultRadioValue,
  draftFromEntry,
  emptyDraft,
  modelRegistryKeys,
  repointChoices,
  type TestButtonState,
  testAllByAlias,
  testButtonState,
  testedAtFor,
  testSubjectKey,
  unboundLabel,
} from '../lib/model-registry';
import {
  recordModelTest,
  TEST_ALL_SUBJECT,
  useCooldownClock,
  useModelTestLog,
} from '../lib/model-test-log';
import {
  addedProviderMessage,
  importLines,
  providerGroups,
  providerTestKey,
  unadoptedBannerText,
} from '../lib/providers-and-models';
import { AddProviderDrawer } from './add-provider-drawer';
import { EditProviderDrawer } from './edit-provider-drawer';
import { ModelDrawer } from './model-drawer';
import {
  MICRO,
  MONO,
  messageOf,
  ProblemLines,
  ReferentItem,
  RefusalNotice,
  SUB,
  TestButton,
  TOOLBAR,
} from './model-registry-notices';
import { RemoveModelDialog } from './model-remove-dialog';
import { ModelRow, type ModelRowProps, ProviderGroup } from './provider-group';
import { SelfSaveMarker } from './self-save-marker';

/** The role Select's "Unbound" value — `setRole` gets `null` for it. */
const UNBOUND = '';

/** `adopting` while "Add all to models" runs, rather than one provider's row. */
const ALL = Symbol('all');

const ROLE_NOTES: Record<BindableRole, ReactNode> = {
  trivial: 'Short, cheap turns.',
  deep: (
    <>
      Asked for with <span style={MONO}>/tier deep</span>.
    </>
  ),
  dreaming: 'Memory consolidation runs.',
};

const ROLES_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: '8px 16px',
  marginTop: 8,
};

const ROLE_BOX: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '10px 12px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
};

const BANNER: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 14px',
  margin: '8px 0',
  fontSize: 13,
  border: '1px solid color-mix(in srgb, var(--warning) 40%, var(--border-subtle))',
  borderRadius: 'var(--radius-md)',
  background: 'color-mix(in srgb, var(--warning) 8%, transparent)',
};

const HINT: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)' };

type DrawerState =
  | { mode: 'create'; provider: string }
  | { mode: 'update'; entry: ModelRegistryEntryView };

interface RemovalState {
  alias: string;
  referents: ModelReferent[];
  refusal: ModelRegistryRefusal | null;
  pending: 'repoint' | 'force' | null;
}

interface ScopedRefusal {
  /** The provider key it belongs under; null = the top of the section. */
  scope: string | null;
  refusal: Pick<ModelRegistryRefusal, 'message' | 'problems'>;
}

/** "Test" on a provider header reads "Test connection". */
function connectionLabel(state: TestButtonState): TestButtonState {
  return { ...state, label: state.label.replace(/^Test/, 'Test connection') };
}

function adoptedMessage(result: Extract<ModelRegistryImportChainResult, { ok: true }>): string {
  const n = result.adopted.length;
  const lead = `Added ${n} model${n === 1 ? '' : 's'} to models.`;
  return result.defaultSet !== null ? `${lead} ${result.defaultSet} is the default.` : lead;
}

export function ModelRegistrySection() {
  const qc = useQueryClient();
  const { notification, modal } = AntApp.useApp();
  const listQuery = useQuery({
    queryKey: modelRegistryKeys.list(),
    queryFn: () => rpc.modelRegistry.list(),
  });
  const log = useModelTestLog();
  const now = useCooldownClock(log.testedAt);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ScopedRefusal | null>(null);
  const [removal, setRemoval] = useState<RemovalState | null>(null);
  const [attention, setAttention] = useState<{ alias: string; referents: ModelReferent[] } | null>(
    null,
  );
  const [testingAlias, setTestingAlias] = useState<string | null>(null);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<string | typeof ALL | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: modelRegistryKeys.all() });
  const failed = (message: string, err: unknown) =>
    notification.error({ message, description: messageOf(err) });

  async function write(call: () => Promise<ModelRegistryWriteResult>, failure: string) {
    try {
      const result = await call();
      setRefusal(result.ok ? null : { scope: null, refusal: result });
    } catch (err) {
      failed(failure, err);
    } finally {
      await refresh();
    }
  }

  async function providerWrite(
    key: string,
    call: () => Promise<ModelRegistryProviderWriteResult>,
    failure: string,
  ) {
    setBusyProvider(key);
    try {
      const result = await call();
      setRefusal(result.ok ? null : { scope: key, refusal: result });
    } catch (err) {
      failed(failure, err);
    } finally {
      setBusyProvider(null);
      await refresh();
    }
  }

  async function adopt(providerKey: string | null) {
    setAdopting(providerKey ?? ALL);
    try {
      const result = await rpc.modelRegistry.importChain(
        providerKey === null ? {} : { providerKeys: [providerKey] },
      );
      if (result.ok) {
        setRefusal(null);
        notification.success({ message: adoptedMessage(result) });
      } else {
        setRefusal({ scope: providerKey, refusal: result });
      }
    } catch (err) {
      failed('Could not add the chain models to models', err);
    } finally {
      setAdopting(null);
      await refresh();
    }
  }

  async function testAlias(alias: string) {
    const subject = { alias };
    setTestingAlias(alias);
    try {
      const outcome = await rpc.modelRegistry.test(subject);
      recordModelTest({
        subjectKeys: [testSubjectKey(subject)],
        testedAt: testedAtFor(outcome, Date.now()),
        outcomes: { [alias]: outcome },
      });
    } catch (err) {
      failed(`Could not run the test for ${alias}`, err);
    } finally {
      setTestingAlias(null);
    }
  }

  async function testProvider(key: string) {
    setTestingProvider(key);
    try {
      const outcome = await rpc.modelRegistry.testProvider({ providerKey: key });
      recordModelTest({
        subjectKeys: [providerTestKey(key)],
        testedAt: testedAtFor(outcome, Date.now()),
        outcomes: { [providerTestKey(key)]: outcome },
      });
    } catch (err) {
      failed(`Could not test ${key}`, err);
    } finally {
      setTestingProvider(null);
    }
  }

  async function testAll() {
    setTestingAll(true);
    try {
      const outcomes = testAllByAlias(await rpc.modelRegistry.testAll());
      recordModelTest({
        subjectKeys: [
          TEST_ALL_SUBJECT,
          ...Object.keys(outcomes).map((alias) => testSubjectKey({ alias })),
        ],
        testedAt: Date.now(),
        outcomes,
      });
    } catch (err) {
      failed('Could not run Test all', err);
    } finally {
      setTestingAll(false);
    }
  }

  async function runRemove(input: { alias: string; repointTo?: string; force?: boolean }) {
    const fromDialog = input.repointTo !== undefined || input.force === true;
    if (fromDialog) {
      setRemoval((r) =>
        r ? { ...r, refusal: null, pending: input.force ? 'force' : 'repoint' } : r,
      );
    }
    try {
      const result = await rpc.modelRegistry.remove(input);
      if (result.ok) {
        setRemoval(null);
        setRefusal(null);
        setAttention(
          result.needsAttention.length > 0
            ? { alias: result.alias, referents: result.needsAttention }
            : null,
        );
        // A repoint can rewrite a personality's own config.yaml.
        if (result.rewritten.some((r) => r.kind === 'personality')) {
          void qc.invalidateQueries({ queryKey: ['personalities'] });
        }
        return;
      }
      if (result.code === 'referenced') {
        setRemoval({
          alias: input.alias,
          referents: result.referents,
          refusal: null,
          pending: null,
        });
        return;
      }
      if (fromDialog) setRemoval((r) => (r ? { ...r, refusal: result, pending: null } : r));
      else setRefusal({ scope: null, refusal: result });
    } catch (err) {
      setRemoval((r) => (r ? { ...r, pending: null } : r));
      failed(`Could not remove ${input.alias}`, err);
    } finally {
      await refresh();
    }
  }

  function onRemove(entry: ModelRegistryEntryView) {
    // Something names it: ask the server, whose refusal lists exactly what —
    // that refusal is what opens the dialog.
    if (entry.referents.length > 0) {
      void runRemove({ alias: entry.alias });
      return;
    }
    modal.confirm({
      title: `Remove ${entry.alias}?`,
      content: 'Nothing uses it, so nothing else changes.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: () => runRemove({ alias: entry.alias }),
    });
  }

  if (listQuery.isLoading) return <Spin size="small" />;
  if (listQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load models: {messageOf(listQuery.error)}
      </Typography.Text>
    );
  }
  const list = listQuery.data;
  if (!list) return null;

  function confirmAddAll() {
    if (!list) return;
    modal.confirm({
      title: 'Add all to models?',
      width: 520,
      content: (
        <div className="model-import-confirm" style={{ fontSize: 13 }}>
          <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)' }}>
            One save to config.yaml. Nothing changes at runtime.
          </p>
          <ul
            style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            {importLines(list.chainModels).map((line) => (
              <li key={`${line.providerKey}/${line.modelId}`}>
                <span style={MONO}>{line.alias}</span> →{' '}
                <span style={MONO}>
                  {line.providerKey}/{line.modelId}
                </span>
                {line.writesId !== null ? (
                  <span style={SUB}>
                    Also writes <span style={MONO}>{line.writesId}</span>, so models can name it.
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ),
      okText: 'Add all to models',
      onOk: () => adopt(null),
    });
  }

  const selectedDefault = defaultRadioValue(list);
  const { groups, orphans } = providerGroups(list);
  const allLeft = cooldownSeconds(log.testedAt[TEST_ALL_SUBJECT], now);
  const allReason =
    list.entries.length === 0
      ? 'Add a model first.'
      : allLeft > 0
        ? `Tested moments ago. Available again in ${allLeft}s.`
        : null;
  const banner = unadoptedBannerText(list.chainModels.length);
  const editing: ModelProviderEntryView | undefined = list.providerEntries.find(
    (e) => e.key === editingProvider,
  );

  const modelRow = (entry: ModelRegistryEntryView): ModelRowProps => ({
    model: entry,
    testState: testButtonState({
      credential: entry.credential,
      providerKey: entry.providerKey,
      ready: true,
      testedAt: log.testedAt[testSubjectKey({ alias: entry.alias })],
      now,
    }),
    testing: testingAlias === entry.alias,
    outcome: log.outcomes[entry.alias],
    onTest: () => void testAlias(entry.alias),
    onEdit: () => setDrawer({ mode: 'update', entry }),
    onRemove: () => onRemove(entry),
  });

  return (
    <div className="settings-models">
      <div style={TOOLBAR}>
        <SelfSaveMarker />
        <div style={{ display: 'flex', gap: 8 }}>
          <TestButton
            state={{
              disabled: allReason !== null,
              label: allLeft > 0 ? `Test all · ${allLeft}s` : 'Test all',
              reason: allReason,
            }}
            loading={testingAll}
            onClick={() => void testAll()}
          />
          <Button size="small" type="primary" onClick={() => setAddingProvider(true)}>
            Add provider
          </Button>
        </div>
      </div>

      {list.chainModels.length > 0 ? (
        <div className="settings-models-unadopted" style={BANNER}>
          <span>
            <span style={{ fontWeight: 500 }}>{banner.lead}</span> {banner.rest}
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Button size="small" type="primary" loading={adopting === ALL} onClick={confirmAddAll}>
              Add all to models
            </Button>
            <span style={HINT}>
              Same as <span style={MONO}>ethos migrate models</span>
            </span>
          </div>
        </div>
      ) : null}

      {refusal !== null && refusal.scope === null ? (
        <RefusalNotice refusal={refusal.refusal} />
      ) : null}

      {attention ? (
        <div role="status" style={{ fontSize: 13, margin: '8px 0' }}>
          <span style={{ color: 'var(--warning)' }}>⚠ </span>
          Removed <span style={MONO}>{attention.alias}</span>. These still name it and won't run
          until they're pointed at another model:
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--text-secondary)' }}>
            {attention.referents.map((r) => (
              <ReferentItem key={JSON.stringify(r)} referent={r} />
            ))}
          </ul>
        </div>
      ) : null}

      {list.problems.length > 0 ? (
        <div style={{ margin: '8px 0' }}>
          <ProblemLines problems={list.problems} />
        </div>
      ) : null}

      {list.entries.length > 0 && list.default === null ? (
        <div style={{ fontSize: 13, margin: '8px 0' }}>
          <span style={{ color: 'var(--warning)' }}>⚠ </span>
          No default model. Choose one with the Default radio.
        </div>
      ) : null}

      <Radio.Group
        value={selectedDefault}
        onChange={(e) =>
          void write(
            () => rpc.modelRegistry.setDefault({ alias: String(e.target.value) }),
            'Could not change the default model',
          )
        }
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        {groups.length === 0 && orphans.length === 0 ? (
          <span style={{ ...HINT, fontSize: 13 }}>
            No providers yet. Add one, then choose the models personalities and roles can use.
          </span>
        ) : null}
        {groups.map((group, i) => {
          const key = group.entry.key;
          return (
            <ProviderGroup
              key={key}
              group={group}
              isLast={i === groups.length - 1}
              testState={connectionLabel(
                testButtonState({
                  credential: group.entry.credential,
                  providerKey: key,
                  ready: true,
                  testedAt: log.testedAt[providerTestKey(key)],
                  now,
                }),
              )}
              testing={testingProvider === key}
              outcome={log.outcomes[providerTestKey(key)]}
              busy={busyProvider === key}
              adopting={adopting === key}
              refusal={refusal !== null && refusal.scope === key ? refusal.refusal : null}
              modelRow={modelRow}
              onTest={() => void testProvider(key)}
              onEdit={() => setEditingProvider(key)}
              onMove={(direction) =>
                void providerWrite(
                  key,
                  () => rpc.modelRegistry.moveProvider({ key, direction }),
                  `Could not move ${key}`,
                )
              }
              onFailover={(failover) =>
                void providerWrite(
                  key,
                  () => rpc.modelRegistry.setProviderFailover({ key, failover }),
                  `Could not change failover for ${key}`,
                )
              }
              onFallbackModel={(alias) =>
                void providerWrite(
                  key,
                  () => rpc.modelRegistry.setFallbackModel({ key, alias }),
                  `Could not change the fallback model for ${key}`,
                )
              }
              onAdopt={() => void adopt(key)}
              onAddModel={() => setDrawer({ mode: 'create', provider: key })}
            />
          );
        })}
        {orphans.length > 0 ? (
          <div className="settings-provider-group settings-provider-group--orphans">
            <div style={{ fontSize: 13, margin: '4px 0' }}>
              <span style={{ color: 'var(--warning)' }}>⚠ </span>
              These models name a provider that isn't in the chain. Edit each to choose one.
            </div>
            {orphans.map((entry) => (
              <ModelRow key={entry.alias} {...modelRow(entry)} />
            ))}
          </div>
        ) : null}
      </Radio.Group>

      <div style={{ marginTop: 16 }}>
        <span style={MICRO}>roles</span>
        <div style={ROLES_GRID}>
          <div style={ROLE_BOX}>
            <span style={MONO}>default</span>
            <Tooltip title="Set by the Default radio above.">
              <span style={{ ...MONO, fontSize: 13 }}>{selectedDefault ?? '—'}</span>
            </Tooltip>
            <span style={SUB}>Set by the Default radio above.</span>
          </div>
          {BINDABLE_ROLES.map((role) => (
            <div key={role} style={ROLE_BOX}>
              <label htmlFor={`model-role-${role}`} style={MONO}>
                {role}
              </label>
              <Select
                id={`model-role-${role}`}
                size="small"
                value={list.roles[role] ?? UNBOUND}
                onChange={(value: string) =>
                  void write(
                    () =>
                      rpc.modelRegistry.setRole({
                        role,
                        alias: value === UNBOUND ? null : value,
                      }),
                    `Could not bind the ${role} role`,
                  )
                }
                options={[
                  { value: UNBOUND, label: unboundLabel(list) },
                  ...list.entries.map((e) => ({
                    value: e.alias,
                    label: <span style={MONO}>{e.alias}</span>,
                  })),
                ]}
              />
              <span style={SUB}>{ROLE_NOTES[role]}</span>
            </div>
          ))}
        </div>
      </div>

      {drawer ? (
        <ModelDrawer
          mode={drawer.mode}
          initial={
            drawer.mode === 'update'
              ? draftFromEntry(drawer.entry)
              : { ...emptyDraft(), provider: drawer.provider }
          }
          providerLocked={drawer.mode === 'create'}
          list={list}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null);
            setRefusal(null);
            void refresh();
          }}
        />
      ) : null}

      {addingProvider ? (
        <AddProviderDrawer
          takenKeys={list.providerEntries.map((e) => e.key)}
          existingAliases={list.entries.map((e) => e.alias)}
          onClose={() => setAddingProvider(false)}
          onAdded={(result) => {
            setAddingProvider(false);
            setRefusal(null);
            notification.success({ message: addedProviderMessage(result) });
            void refresh();
          }}
        />
      ) : null}

      {editing ? (
        <EditProviderDrawer
          entry={editing}
          onClose={() => setEditingProvider(null)}
          onSaved={() => {
            setEditingProvider(null);
            void refresh();
          }}
          onRemoved={() => {
            setEditingProvider(null);
            setRefusal(null);
            void refresh();
          }}
        />
      ) : null}

      {removal ? (
        <RemoveModelDialog
          alias={removal.alias}
          referents={removal.referents}
          choices={repointChoices(list, removal.alias)}
          refusal={removal.refusal}
          pending={removal.pending}
          onCancel={() => setRemoval(null)}
          onRepoint={(to) => void runRemove({ alias: removal.alias, repointTo: to })}
          onForce={() => void runRemove({ alias: removal.alias, force: true })}
        />
      ) : null}
    </div>
  );
}
