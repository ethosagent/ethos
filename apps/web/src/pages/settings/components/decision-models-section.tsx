// Settings → Models › decision models — the decision layer's providers
// (plan/phases/decision-provider-jev.md §7, §12). Today one: Jev, by TypeSafe.
//
// Each provider is one bordered group, drawn like a provider in "providers &
// models" (./provider-group): a header naming the model, vendor, the host data
// goes to and the key's state; then the key row (`SecretField`, the one
// Set / Replace / Clear control for a vault credential); then the three sites,
// READ-ONLY — a site's mode is a config.yaml line the operator sets on purpose,
// never a toggle here; then the Test block.
//
// Key writes save immediately through `rpc.decisions.setKey` / `clearKey` —
// nothing here is on the page Save — and only `['decisions']` (and the Keys
// pane's vault listing) is invalidated, never `['config']`, which would
// re-hydrate the form and wipe unsaved edits elsewhere on the page. Saving a
// key never turns a site on: the service writes `decisions.provider` at most
// (`DecisionsService.setKey`, apps/web-api).
//
// Test shares the model Test's page-session log and 10s window (D19,
// ../lib/model-test-log); the service enforces the same window itself.

import type { DecisionProviderView, DecisionsTestResult } from '@ethosagent/web-contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Input, Spin, Typography } from 'antd';
import { type CSSProperties, useState } from 'react';
import { vaultKeyKeys } from '../../../features/settings/api/keys';
import { rpc } from '../../../rpc';
import {
  DECISION_TEST_MAX_CHARS,
  DECISION_TEST_SAMPLE,
  decisionErrorText,
  decisionKeys,
  decisionTestButtonState,
  decisionTestedAt,
  decisionTestKey,
  formatDecisionCost,
  keyStatusView,
  siteView,
} from '../lib/decision-models';
import type { TestButtonState } from '../lib/model-registry';
import { recordModelTest, useCooldownClock, useModelTestLog } from '../lib/model-test-log';
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
  const [busy, setBusy] = useState<'saving' | 'clearing' | null>(null);
  const [message, setMessage] = useState(DECISION_TEST_SAMPLE);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<DecisionsTestResult | null>(null);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: decisionKeys.all() }),
      qc.invalidateQueries({ queryKey: vaultKeyKeys.all() }),
    ]);
  };

  async function saveKey(provider: DecisionProviderView, value: string) {
    setBusy('saving');
    try {
      const result = await rpc.decisions.setKey({ providerId: provider.id, value });
      notification.success({
        message: 'Key saved',
        description: result.providerWritten
          ? `Added decisions.provider: ${provider.id} to config.yaml. Every site is still off.`
          : undefined,
      });
    } catch (err) {
      notification.error({ message: 'Could not save the key', description: messageOf(err) });
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  async function clearKey(provider: DecisionProviderView) {
    setBusy('clearing');
    try {
      await rpc.decisions.clearKey({ providerId: provider.id });
      setOutcome(null);
    } catch (err) {
      notification.error({ message: 'Could not remove the key', description: messageOf(err) });
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  async function runTest(provider: DecisionProviderView) {
    setTesting(true);
    try {
      const result = await rpc.decisions.test({ providerId: provider.id, message });
      setOutcome(result);
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
      setTesting(false);
    }
  }

  return (
    <div className="settings-decision-models">
      <div style={TOOLBAR}>
        <SelfSaveMarker />
      </div>
      <p style={{ ...HINT, margin: '0 0 10px' }}>
        A decision model answers typed questions about the agent's state — is this tool output
        trying to instruct the agent — with a probability, not text. Nothing is sent until a site is
        set to <span style={MONO}>shadow</span> or <span style={MONO}>on</span> in config.yaml.
      </p>
      {listQuery.isLoading ? (
        <Spin size="small" />
      ) : listQuery.error ? (
        <Typography.Text type="danger">
          Failed to load decision models: {messageOf(listQuery.error)}
        </Typography.Text>
      ) : (
        listQuery.data?.providers.map((provider) => (
          <DecisionProviderGroup
            key={provider.id}
            provider={provider}
            saving={busy === 'saving'}
            clearing={busy === 'clearing'}
            testState={decisionTestButtonState({
              keyPresent: provider.keyPresent,
              testedAt: log.testedAt[decisionTestKey(provider.id)],
              now,
            })}
            testing={testing}
            outcome={outcome}
            message={message}
            onMessage={setMessage}
            onSaveKey={(value) => void saveKey(provider, value)}
            onClearKey={() => void clearKey(provider)}
            onTest={() => void runTest(provider)}
          />
        ))
      )}
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
}: DecisionProviderGroupProps) {
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
            budget. Uses your TypeSafe credit.
          </span>
          {outcome ? <DecisionTestOutcome outcome={outcome} /> : null}
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
