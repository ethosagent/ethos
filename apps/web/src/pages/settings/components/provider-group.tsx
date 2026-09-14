// One provider in Settings → Models › providers & models (approved mockup,
// frames 1 and 2): a header — key, type and credential, Test connection, Edit,
// its place in the fallback order, Failover, Fallback model — then its models
// as rows, then the chain models the registry does not hold yet, then
// "+ Add model to <provider>".
//
// Every control calls back into `ModelRegistrySection`, which owns the RPCs,
// the refetch and the dialogs. The Default radio of each model row belongs to
// the section's one `Radio.Group`, so exactly one is checked across providers.

import type {
  ModelRegistryEntryView,
  ModelRegistryRefusal,
  ModelRegistryTestResult,
} from '@ethosagent/web-contracts';
import { Button, Popover, Radio, Select, Switch, Tooltip } from 'antd';
import { type CSSProperties, useId } from 'react';
import { ModelTestOutcome } from '../../../components/models/ModelTestOutcome';
import {
  formatContextWindow,
  formatCost,
  lastTestView,
  type TestButtonState,
} from '../lib/model-registry';
import {
  fallbackModelChoice,
  modelSubParts,
  orderLabel,
  type ProviderGroup as ProviderGroupData,
  providerAuthView,
} from '../lib/providers-and-models';
import { MONO, RefusalNotice, StatusText, TestButton } from './model-registry-notices';

const GROUP: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  minWidth: 0,
};

const HEAD: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px 12px',
  padding: '10px 12px',
  borderBottom: '1px solid var(--border-subtle)',
  background: 'var(--ethos-surface-tint)',
  borderStartStartRadius: 'var(--radius-md)',
  borderStartEndRadius: 'var(--radius-md)',
};

const NAME_LINE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '4px 10px',
  minWidth: 0,
};

const META: CSSProperties = {
  gridColumn: '1 / -1',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '6px 16px',
  fontSize: 12,
  color: 'var(--text-secondary)',
};

const INLINE: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 };

const ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '18px minmax(0, 1fr) auto',
  gap: '4px 10px',
  alignItems: 'start',
  padding: '9px 12px',
  borderBottom: '1px solid var(--border-subtle)',
};

const PENDING_ROW: CSSProperties = {
  ...ROW,
  background: 'color-mix(in srgb, var(--warning) 8%, transparent)',
};

const NAME: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 };

const SUB_LINE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '2px 10px',
  fontSize: 12,
  color: 'var(--text-tertiary)',
};

const RIGHT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 3,
};

const ACTIONS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 4,
};

const HINT: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)' };

/** Edit / Remove: a size below antd's `small`, so they sit beside Test. */
const COMPACT_ACTION: CSSProperties = { fontSize: 12, paddingInline: 4 };

const PLAIN_BUTTON: CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'right',
};

/** The Fallback model Select's "no line" value — `setFallbackModel` gets `null`. */
const NO_FALLBACK = '';

/** The last test's status word; hover or click for the whole outcome. */
export function TestStatus({ outcome }: { outcome: ModelRegistryTestResult | undefined }) {
  const view = lastTestView(outcome);
  if (!outcome) return <StatusText view={view} wrap />;
  return (
    <Popover
      trigger={['hover', 'click']}
      content={
        <div style={{ maxWidth: 440 }}>
          <ModelTestOutcome outcome={outcome} />
        </div>
      }
    >
      <button type="button" style={PLAIN_BUTTON}>
        <StatusText view={{ ...view, title: null }} wrap />
      </button>
    </Popover>
  );
}

export interface ModelRowProps {
  model: ModelRegistryEntryView;
  testState: TestButtonState;
  testing: boolean;
  outcome: ModelRegistryTestResult | undefined;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

export function ModelRow({
  model,
  testState,
  testing,
  outcome,
  onTest,
  onEdit,
  onRemove,
}: ModelRowProps) {
  const parts = modelSubParts(model, { context: formatContextWindow, cost: formatCost });
  return (
    <div className="settings-model-row" data-alias={model.alias} style={ROW}>
      <Radio
        value={model.alias}
        aria-label={`Make ${model.alias} the default`}
        style={{ marginInlineEnd: 0, marginTop: 2 }}
      />
      <div style={NAME}>
        <span style={{ ...MONO, fontSize: 13, overflowWrap: 'anywhere' }}>{model.alias}</span>
        <span style={SUB_LINE}>
          <span style={{ ...MONO, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
            {model.modelId}
          </span>
          {parts.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </span>
      </div>
      <div style={RIGHT}>
        <div style={ACTIONS}>
          <TestButton state={testState} loading={testing} onClick={onTest} />
          <Button size="small" type="text" style={COMPACT_ACTION} onClick={onEdit}>
            Edit
          </Button>
          <Button size="small" type="text" style={COMPACT_ACTION} onClick={onRemove}>
            Remove
          </Button>
        </div>
        <TestStatus outcome={outcome} />
      </div>
    </div>
  );
}

export interface ProviderGroupProps {
  group: ProviderGroupData;
  isLast: boolean;
  /** Test connection's button state, already relabelled. */
  testState: TestButtonState;
  testing: boolean;
  outcome: ModelRegistryTestResult | undefined;
  /** A provider write for this entry is in flight. */
  busy: boolean;
  adopting: boolean;
  refusal: Pick<ModelRegistryRefusal, 'message' | 'problems'> | null;
  modelRow: (model: ModelRegistryEntryView) => ModelRowProps;
  onTest: () => void;
  onEdit: () => void;
  onMove: (direction: 'up' | 'down') => void;
  onFailover: (failover: boolean) => void;
  onFallbackModel: (alias: string | null) => void;
  onAdopt: () => void;
  onAddModel: () => void;
}

export function ProviderGroup({
  group,
  isLast,
  testState,
  testing,
  outcome,
  busy,
  adopting,
  refusal,
  modelRow,
  onTest,
  onEdit,
  onMove,
  onFailover,
  onFallbackModel,
  onAdopt,
  onAddModel,
}: ProviderGroupProps) {
  const ids = useId();
  const { entry, position } = group;
  const fallback = fallbackModelChoice(group);
  const add = (
    <Button size="small" type="dashed" disabled={!entry.referenceable} onClick={onAddModel}>
      + Add model to {entry.key}
    </Button>
  );

  return (
    <div className="settings-provider-group" data-provider-key={entry.key} style={GROUP}>
      <div className="settings-provider-head" style={HEAD}>
        <div style={NAME_LINE}>
          <span style={{ ...MONO, fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere' }}>
            {entry.key}
          </span>
          <span style={HINT}>
            {entry.provider} · <StatusText view={providerAuthView(entry)} />
          </span>
        </div>
        <div style={RIGHT}>
          <div style={ACTIONS}>
            <TestButton state={testState} loading={testing} onClick={onTest} />
            <Button size="small" type="text" style={COMPACT_ACTION} onClick={onEdit}>
              Edit
            </Button>
          </div>
          {outcome ? <TestStatus outcome={outcome} /> : null}
        </div>
        <div style={META}>
          <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
            {orderLabel(position)}
          </span>
          {position > 0 || !isLast ? (
            <span style={INLINE}>
              {position > 0 ? (
                <Button
                  size="small"
                  aria-label={`Move ${entry.key} up`}
                  disabled={busy}
                  onClick={() => onMove('up')}
                >
                  Up
                </Button>
              ) : null}
              {!isLast ? (
                <Button
                  size="small"
                  aria-label={`Move ${entry.key} down`}
                  disabled={busy}
                  onClick={() => onMove('down')}
                >
                  Down
                </Button>
              ) : null}
            </span>
          ) : null}
          <span style={INLINE}>
            <Switch
              id={`${ids}-failover`}
              size="small"
              checked={entry.failover}
              disabled={busy}
              onChange={onFailover}
            />
            <label htmlFor={`${ids}-failover`}>Failover</label>
            {entry.failover ? null : <span style={HINT}>· credential only, not a fallback</span>}
          </span>
          {entry.failover ? (
            <span style={INLINE}>
              <label htmlFor={`${ids}-fallback`} style={HINT}>
                Fallback model
              </label>
              <Select
                id={`${ids}-fallback`}
                className="settings-fallback-model"
                size="small"
                disabled={busy}
                value={fallback.alias ?? NO_FALLBACK}
                popupMatchSelectWidth={false}
                style={{ minWidth: 120, maxWidth: '100%' }}
                onChange={(value: string) => onFallbackModel(value === NO_FALLBACK ? null : value)}
                options={[
                  {
                    value: NO_FALLBACK,
                    label:
                      fallback.unmatched !== null ? (
                        <span style={{ color: 'var(--warning)' }}>
                          ⚠ <span style={MONO}>{fallback.unmatched}</span>
                        </span>
                      ) : (
                        'None'
                      ),
                  },
                  ...group.models.map((m) => ({
                    value: m.alias,
                    label: <span style={MONO}>{m.alias}</span>,
                  })),
                ]}
              />
            </span>
          ) : null}
        </div>
      </div>

      {refusal ? (
        <div style={{ padding: '0 12px' }}>
          <RefusalNotice refusal={refusal} />
        </div>
      ) : null}

      {group.models.map((model) => (
        <ModelRow key={model.alias} {...modelRow(model)} />
      ))}

      {group.pending.map((chain) => (
        <div
          key={`${chain.index}:${chain.modelId}`}
          className="settings-model-row settings-model-row--pending"
          data-model-id={chain.modelId}
          style={PENDING_ROW}
        >
          <span />
          <div style={NAME}>
            <span style={{ ...MONO, fontSize: 13, overflowWrap: 'anywhere' }}>{chain.modelId}</span>
            <span style={SUB_LINE}>
              <StatusText
                view={{ tone: 'warn', text: '⚠ In provider chain, not in models yet', title: null }}
                wrap
              />
              <span>
                adds as <span style={MONO}>{chain.suggestedAlias}</span>
              </span>
            </span>
          </div>
          <div style={RIGHT}>
            <Button size="small" loading={adopting} onClick={onAdopt}>
              Add to models
            </Button>
          </div>
        </div>
      ))}

      {group.models.length === 0 && group.pending.length === 0 ? (
        <div style={{ ...HINT, padding: '9px 12px' }}>No models on this provider yet.</div>
      ) : null}

      <div style={{ padding: '8px 12px' }}>
        {entry.referenceable ? (
          add
        ) : (
          <Tooltip title={entry.reason ?? 'This provider has no id yet.'}>
            <span>{add}</span>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
