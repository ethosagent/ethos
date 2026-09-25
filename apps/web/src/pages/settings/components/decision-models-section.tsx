// Settings → Models › decision models — a KIND of model, distinct from the
// chat models above: it answers typed questions about the agent's state
// (yes/no, a choice, a score) with a probability instead of writing text
// (plan/phases/decision-provider-jev.md §7, §12).
//
// Laid out like "providers & models" (./model-registry-section): a toolbar
// with "Add decision model", then one bordered group per ADDED decision model
// — `decisions.list`'s `providers`, which holds only the ones with a stored
// key or named by `decisions.provider` — and an empty state when there are
// none. The Add drawer lists the catalog types not yet added
// (`addableDecisionTypes`); the catalog itself is the server's
// (`DECISION_PROVIDER_CATALOG`, apps/web-api services/decision-catalog.ts), so
// a second provider needs no change here. Today the catalog holds one type:
// Jev, by TypeSafe.
//
// Each group: a header naming the model, vendor, the host data goes to, the
// key's state, an "active" marker when `decisions.provider` names it (config
// allows ONE active decision model; switching between several is not built),
// and Remove; then the key row (`SecretField`, the one Set / Replace / Clear
// control for a vault credential); then the three sites, READ-ONLY — a site's
// mode is a config.yaml line the operator sets on purpose, never a toggle
// here; then the Test block.
//
// Every write saves immediately through `rpc.decisions.setKey` / `clearKey` /
// `remove` — nothing here is on the page Save — and only `['decisions']` (and
// the Keys pane's vault listing) is invalidated, never `['config']`, which
// would re-hydrate the form and wipe unsaved edits elsewhere on the page.
// Saving a key never turns a site on: the service writes `decisions.provider`
// at most (`DecisionsService.setKey`, apps/web-api). Remove deletes the key and
// that provider line, and leaves the site lines (`DecisionsService.remove`).
//
// Test shares the model Test's page-session log and 10s window (D19,
// ../lib/model-test-log); the service enforces the same window itself. A
// result is scrolled clear of the page's sticky Save bar
// (`.settings-savebar-clearance`, styles.css).

import type {
  DecisionProviderView,
  DecisionsListResult,
  DecisionsTestResult,
} from '@ethosagent/web-contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Input, Modal, Spin, Tooltip, Typography } from 'antd';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { vaultKeyKeys } from '../../../features/settings/api/keys';
import { rpc } from '../../../rpc';
import {
  addableDecisionTypes,
  addDecisionButtonState,
  DECISION_TEST_MAX_CHARS,
  DECISION_TEST_SAMPLE,
  decisionErrorText,
  decisionKeys,
  decisionTestButtonState,
  decisionTestedAt,
  decisionTestKey,
  formatDecisionCost,
  keyStatusView,
  removeDecisionConsequences,
  savedKeyNotice,
  siteView,
} from '../lib/decision-models';
import type { TestButtonState } from '../lib/model-registry';
import { recordModelTest, useCooldownClock, useModelTestLog } from '../lib/model-test-log';
import { AddDecisionModelDrawer } from './add-decision-model-drawer';
import {
  MICRO,
  MONO,
  messageOf,
  StatusText,
  SUB,
  TestButton,
  TOOLBAR,
} from './model-registry-notices';
import { type KeyEntryView, SecretField } from './secret-field';
import { SelfSaveMarker } from './self-save-marker';
import { SettingRow } from './setting-row';

const GROUP: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  minWidth: 0,
};

const HEAD: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '4px 10px',
  padding: '10px 12px',
  borderBottom: '1px solid var(--border-subtle)',
  background: 'var(--ethos-surface-tint)',
  borderStartStartRadius: 'var(--radius-md)',
  borderStartEndRadius: 'var(--radius-md)',
};

const BODY: CSSProperties = { padding: '0 12px 12px' };

const HINT: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)' };

/** Remove: a size below antd's `small`, as in ./provider-group. */
const COMPACT_ACTION: CSSProperties = { fontSize: 12, paddingInline: 4 };

const SITES: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 4,
  fontSize: 13,
};

const RESULT: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'max-content minmax(0, 1fr)',
  gap: '4px 16px',
  margin: '10px 0 0',
  fontSize: 13,
};

/**
 * The `SecretField` view of a decision provider's key. `category` is required
 * by the Keys-pane type and read by nothing `SecretField` renders; `custom` is
 * the honest bucket, since no Keys-pane catalog entry claims this ref.
 */
export function decisionKeyEntry(provider: DecisionProviderView): KeyEntryView {
  return {
    id: `decisions.${provider.id}`,
    category: 'custom',
    label: 'API key',
    shape: 'single',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        ref: provider.keyRef,
        preview: provider.keyPreview,
        set: provider.keyPresent,
      },
    ],
    set: provider.keyPresent,
    canSet: true,
    canClear: true,
    getKeyUrl: provider.getKeyUrl,
  };
}

export function DecisionModelsSection() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const listQuery = useQuery({
    queryKey: decisionKeys.list(),
    queryFn: () => rpc.decisions.list(),
  });
  const log = useModelTestLog();
  const now = useCooldownClock(log.testedAt);
  const [busy, setBusy] = useState<{ id: string; kind: 'saving' | 'clearing' } | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, DecisionsTestResult>>({});
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DecisionProviderView | null>(null);
  const [removePending, setRemovePending] = useState(false);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: decisionKeys.all() }),
      qc.invalidateQueries({ queryKey: vaultKeyKeys.all() }),
    ]);
  };

  const forget = (id: string) =>
    setOutcomes((o) => {
      const { [id]: _dropped, ...rest } = o;
      return rest;
    });

  /** The saved-key notice, read against the refreshed list. */
  async function noticeFor(providerId: string, providerWritten: boolean) {
    await refresh();
    const fresh = qc.getQueryData<DecisionsListResult>(decisionKeys.list());
    return savedKeyNotice({
      providerId,
      providerWritten,
      sites: fresh?.providers.find((p) => p.id === providerId)?.sites,
    });
  }

  async function saveKey(provider: DecisionProviderView, value: string) {
    setBusy({ id: provider.id, kind: 'saving' });
    try {
      const result = await rpc.decisions.setKey({ providerId: provider.id, value });
      notification.success({
        message: 'Key saved',
        description: await noticeFor(provider.id, result.providerWritten),
      });
    } catch (err) {
      notification.error({ message: 'Could not save the key', description: messageOf(err) });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function clearKey(provider: DecisionProviderView) {
    setBusy({ id: provider.id, kind: 'clearing' });
    try {
      await rpc.decisions.clearKey({ providerId: provider.id });
      forget(provider.id);
    } catch (err) {
      notification.error({ message: 'Could not remove the key', description: messageOf(err) });
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  async function remove(provider: DecisionProviderView) {
    setRemovePending(true);
    try {
      await rpc.decisions.remove({ providerId: provider.id });
      forget(provider.id);
      setRemoving(null);
      notification.success({ message: `Removed ${provider.label}` });
    } catch (err) {
      notification.error({
        message: `Could not remove ${provider.label}`,
        description: messageOf(err),
      });
    } finally {
      setRemovePending(false);
      await refresh();
    }
  }

  async function runTest(provider: DecisionProviderView) {
    setTestingId(provider.id);
    try {
      const result = await rpc.decisions.test({
        providerId: provider.id,
        message: messages[provider.id] ?? DECISION_TEST_SAMPLE,
      });
      setOutcomes((o) => ({ ...o, [provider.id]: result }));
      recordModelTest({
        subjectKeys: [decisionTestKey(provider.id)],
        testedAt: decisionTestedAt(result, Date.now()),
      });
    } catch (err) {
      notification.error({
        message: `Could not test ${provider.label}`,
        description: messageOf(err),
      });
    } finally {
      setTestingId(null);
    }
  }

  const data = listQuery.data;
  const addState = data ? addDecisionButtonState(data.catalog, data.providers) : null;

  return (
    // The next section heading sits first in an `AdvancedBlock`, where
    // `.settings-section-heading:first-child` drops its 24px top margin; this
    // restores that gap below the list or its empty state.
    <div className="settings-decision-models" style={{ marginBottom: 24 }}>
      <div style={TOOLBAR}>
        <SelfSaveMarker />
        {addState ? (
          <Tooltip title={addState.reason}>
            <Button
              size="small"
              type="primary"
              disabled={addState.disabled}
              onClick={() => setAdding(true)}
            >
              Add decision model
            </Button>
          </Tooltip>
        ) : null}
      </div>
      <p style={{ ...HINT, margin: '0 0 10px' }}>
        A decision model answers typed questions — yes or no, a choice, a score — with a probability
        instead of writing text. It is a separate kind of model from the chat models above: it never
        replies to anyone, and nothing is sent to it until a site is set to{' '}
        <span style={MONO}>shadow</span> or <span style={MONO}>on</span> in config.yaml.
      </p>
      {listQuery.isLoading ? (
        <Spin size="small" />
      ) : listQuery.error ? (
        <Typography.Text type="danger">
          Failed to load decision models: {messageOf(listQuery.error)}
        </Typography.Text>
      ) : data && data.providers.length === 0 ? (
        <p className="settings-decision-models-empty" style={{ ...HINT, fontSize: 13, margin: 0 }}>
          No decision models yet. Add one, then choose in config.yaml which sites use it.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data?.providers.map((provider) => (
            <DecisionProviderGroup
              key={provider.id}
              provider={provider}
              saving={busy?.id === provider.id && busy.kind === 'saving'}
              clearing={busy?.id === provider.id && busy.kind === 'clearing'}
              testState={decisionTestButtonState({
                keyPresent: provider.keyPresent,
                testedAt: log.testedAt[decisionTestKey(provider.id)],
                now,
              })}
              testing={testingId === provider.id}
              outcome={outcomes[provider.id] ?? null}
              message={messages[provider.id] ?? DECISION_TEST_SAMPLE}
              onMessage={(m) => setMessages((all) => ({ ...all, [provider.id]: m }))}
              onSaveKey={(value) => void saveKey(provider, value)}
              onClearKey={() => void clearKey(provider)}
              onTest={() => void runTest(provider)}
              onRemove={() => setRemoving(provider)}
            />
          ))}
        </div>
      )}

      {adding && data ? (
        <AddDecisionModelDrawer
          types={addableDecisionTypes(data.catalog, data.providers)}
          onClose={() => setAdding(false)}
          onAdded={async (type, providerWritten) => {
            setAdding(false);
            notification.success({
              message: `Added ${type.label}`,
              description: await noticeFor(type.id, providerWritten),
            });
          }}
        />
      ) : null}

      {removing ? (
        <RemoveDecisionModelDialog
          provider={removing}
          pending={removePending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove(removing)}
        />
      ) : null}
    </div>
  );
}

export interface DecisionProviderGroupProps {
  provider: DecisionProviderView;
  saving: boolean;
  clearing: boolean;
  testState: TestButtonState;
  testing: boolean;
  outcome: DecisionsTestResult | null;
  message: string;
  onMessage: (message: string) => void;
  onSaveKey: (value: string) => void;
  onClearKey: () => void;
  onTest: () => void;
  onRemove: () => void;
}

/** One decision provider. Presentational: every action calls back into the section. */
export function DecisionProviderGroup({
  provider,
  saving,
  clearing,
  testState,
  testing,
  outcome,
  message,
  onMessage,
  onSaveKey,
  onClearKey,
  onTest,
  onRemove,
}: DecisionProviderGroupProps) {
  const outcomeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A result lands below the Test button — often under the sticky Save bar.
    if (outcome) outcomeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [outcome]);
  return (
    <div className="settings-decision-provider" data-provider-id={provider.id} style={GROUP}>
      <div style={HEAD}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{provider.label}</span>
        <span style={HINT}>by {provider.vendor}</span>
        <span style={HINT}>
          sends to <span style={MONO}>{provider.host}</span> · model{' '}
          <span style={MONO}>{provider.model}</span>
        </span>
        <StatusText view={keyStatusView(provider)} />
        {provider.configured ? (
          <span
            className="settings-decision-active"
            style={MICRO}
            title={`decisions.provider: ${provider.id} — the active decision model. config.yaml allows one.`}
          >
            active
          </span>
        ) : null}
        <Button
          size="small"
          type="text"
          style={{ ...COMPACT_ACTION, marginInlineStart: 'auto' }}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      <div style={BODY}>
        <SecretField
          entry={decisionKeyEntry(provider)}
          onSave={(values) => {
            const value = values.apiKey;
            if (value) onSaveKey(value);
          }}
          onClear={onClearKey}
          saving={saving}
          clearing={clearing}
        />
        <SettingRow
          label="Sites"
          help="Set per site in config.yaml (decisions.sites.<site>: off | shadow | on). Read-only here."
        >
          <div style={SITES}>
            {provider.sites.map((site) => {
              const view = siteView(site);
              return (
                <div key={site.site} data-site={site.site} style={{ textAlign: 'right' }}>
                  <span style={MONO}>{site.site}</span>{' '}
                  <StatusText view={{ tone: view.tone, text: view.mode, title: null }} />
                  {view.note ? (
                    <span style={{ ...SUB, color: 'var(--warning)' }}>⚠ {view.note}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </SettingRow>

        <div style={{ paddingTop: 12 }}>
          <div style={{ ...TOOLBAR, marginBottom: 6 }}>
            <span style={MICRO}>test</span>
            <TestButton state={testState} loading={testing} onClick={onTest} />
          </div>
          <Input.TextArea
            aria-label="Test message"
            value={message}
            maxLength={DECISION_TEST_MAX_CHARS}
            autoSize={{ minRows: 3, maxRows: 8 }}
            onChange={(e) => onMessage(e.target.value)}
            style={{ ...MONO, fontSize: 12 }}
          />
          <span style={{ ...SUB, marginTop: 4 }}>
            Asks the injection question once, redacted first, under the injection site's time
            budget. Uses your {provider.vendor} credit.
          </span>
          <div ref={outcomeRef} className="settings-savebar-clearance">
            {outcome ? <DecisionTestOutcome outcome={outcome} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** What one Test learned — every field, or the failure in words. */
export function DecisionTestOutcome({ outcome }: { outcome: DecisionsTestResult }) {
  if (!outcome.ok) {
    return (
      <div role="alert" className="decision-test-error" style={{ marginTop: 10, fontSize: 13 }}>
        <span style={{ color: 'var(--error)' }}>✗ </span>
        {decisionErrorText(outcome.code)}
        <span style={SUB}>{outcome.message}</span>
      </div>
    );
  }
  const { answer } = outcome;
  return (
    <dl className="decision-test-result" style={RESULT}>
      <dt style={HINT}>contains instructions</dt>
      <dd style={{ margin: 0 }}>
        {answer.containsInstructions ? (
          <span style={{ color: 'var(--warning)' }}>⚠ yes</span>
        ) : (
          <span style={{ color: 'var(--success)' }}>✓ no</span>
        )}
      </dd>
      <dt style={HINT}>p</dt>
      <dd style={{ ...MONO, margin: 0 }}>{answer.p.toFixed(3)}</dd>
      <dt style={HINT}>confidence</dt>
      <dd style={{ ...MONO, margin: 0 }}>{answer.confidence.toFixed(3)}</dd>
      <dt style={HINT}>model</dt>
      <dd style={{ ...MONO, margin: 0 }}>{outcome.model}</dd>
      <dt style={HINT}>latency</dt>
      <dd style={{ ...MONO, margin: 0 }}>{outcome.latencyMs} ms</dd>
      <dt style={HINT}>input tokens</dt>
      <dd style={{ ...MONO, margin: 0 }}>{outcome.inputTokens}</dd>
      <dt style={HINT}>cost</dt>
      <dd style={{ ...MONO, margin: 0 }}>{formatDecisionCost(outcome.estimatedCostUsd)}</dd>
      <dt style={HINT}>redaction</dt>
      <dd style={{ margin: 0 }}>
        {outcome.redactedMessage !== undefined ? (
          <>
            Secrets were redacted before sending. Sent:
            <span style={{ ...SUB, ...MONO, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {outcome.redactedMessage}
            </span>
          </>
        ) : (
          'Nothing to redact; sent as typed.'
        )}
      </dd>
    </dl>
  );
}

/**
 * The Remove confirm — the shape of ./model-remove-dialog: what goes, what
 * stays, then Cancel and a danger action. The sentences are
 * `removeDecisionConsequences`, which say what `DecisionsService.remove` does.
 */
export function RemoveDecisionModelDialog({
  provider,
  pending,
  onCancel,
  onConfirm,
}: {
  provider: DecisionProviderView;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open onCancel={onCancel} footer={null} title={`Remove ${provider.label}?`}>
      <RemoveDecisionModelBody
        provider={provider}
        pending={pending}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </Modal>
  );
}

/** The dialog's body, apart from the portal so it renders in a test. */
export function RemoveDecisionModelBody({
  provider,
  pending,
  onCancel,
  onConfirm,
}: {
  provider: DecisionProviderView;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const secondary = { color: 'var(--text-secondary)', margin: 0 };
  return (
    <div
      className="decision-remove-dialog"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {removeDecisionConsequences(provider).map((line) => (
          <li key={line} style={secondary}>
            {line}
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button type="text" onClick={onCancel}>
          Cancel
        </Button>
        <Button danger loading={pending} onClick={onConfirm}>
          Remove
        </Button>
      </div>
    </div>
  );
}
