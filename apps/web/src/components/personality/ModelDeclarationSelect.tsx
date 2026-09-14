import { ExclamationCircleOutlined } from '@ant-design/icons';
import type { ModelRegistryTestResult } from '@ethosagent/web-contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Select, Typography } from 'antd';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { rpc } from '../../rpc';
import { ModelTestOutcome } from '../models/ModelTestOutcome';
import {
  classifyDeclaration,
  type DeclaredModel,
  modelDeclarationGroups,
  resolveTestTarget,
  selectValueFor,
  tierMapNote,
  unknownDeclarationNote,
} from './modelDeclaration';

// The one control that chooses a personality's model — the agentic `model` and
// `voice.model` alike. A closed Select over "Use default", the four roles and
// the registry's aliases: no free text, no tags mode, no AutoComplete (plan
// model-registry D5). Test sits beside it and probes what the selection
// resolves to right now (T2.9).

/** Shared with Settings → Models so a registry write refreshes every picker. */
export const MODEL_REGISTRY_LIST_KEY = ['modelRegistry', 'list'] as const;

/** Client-side mirror of the handler's 10s per-alias limit
 *  (`modelRegistry.test`, which answers `rate_limited` past it). */
const TEST_COOLDOWN_SECONDS = 10;

const MONO = { fontFamily: 'var(--font-mono)' } as const;

const NOTE_STYLE = { display: 'block', fontSize: 12, marginTop: 4 } as const;

/** Floor for the option list, so a name and its hint stay readable. */
const POPUP_MIN_WIDTH = 320;

/** A name or hint too long for the closed field truncates instead of spilling. */
const ELLIPSIS = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

export function ModelDeclarationSelect({
  value,
  onChange,
  inherit,
  ariaLabel,
}: {
  /** The declaration as stored: a role, an alias, a tier map, or absent. */
  value: DeclaredModel;
  /** The new declaration; `''` is "Use default" and clears it. */
  onChange: (next: string) => void;
  /** For a field whose default is another declaration rather than the registry
   *  default — `voice.model` falls back to the personality's own model. */
  inherit?: { hint: string; declared: DeclaredModel };
  ariaLabel: string;
}) {
  const listQuery = useQuery({
    queryKey: MODEL_REGISTRY_LIST_KEY,
    queryFn: () => rpc.modelRegistry.list(),
  });
  const registry = listQuery.data;

  if (listQuery.isError) {
    return (
      <Typography.Text type="danger">
        Could not load the model list: {listQuery.error.message}
      </Typography.Text>
    );
  }
  if (!registry)
    return <Select loading disabled aria-label={ariaLabel} style={{ width: '100%' }} />;

  const state = classifyDeclaration(value, registry);
  const inheritState = inherit ? classifyDeclaration(inherit.declared, registry) : undefined;
  const target = resolveTestTarget(state, registry, inheritState);

  if (registry.entries.length === 0) {
    return (
      <div>
        <Typography.Text type="secondary">
          No models yet. Add one in <Link to="/settings/models">Settings → Models</Link>.
        </Typography.Text>
        {state.kind === 'unknown' ? <UnknownNote value={state.value} /> : null}
        {state.kind === 'tierMap' ? <TierMapNote summary={state.summary} /> : null}
      </div>
    );
  }

  const groups = modelDeclarationGroups(registry, inherit?.hint);
  return (
    <div>
      <ModelTestRow target={target}>
        <Select
          aria-label={ariaLabel}
          style={{ flex: 1, minWidth: 0 }}
          // A number is the popup's width while the select's own width stays its
          // minimum, so the list is never narrower than the field or than 320px.
          popupMatchSelectWidth={POPUP_MIN_WIDTH}
          value={selectValueFor(state)}
          placeholder="Per-tier map"
          status={state.kind === 'unknown' ? 'warning' : undefined}
          onChange={(next: string) => onChange(next)}
          labelRender={({ value: selected }) => {
            const option = groups.flatMap((g) => g.options).find((o) => o.value === selected);
            if (!option) return <span style={MONO}>{String(selected)}</span>;
            return <OptionRow name={option.name} hint={option.hint} mono={option.value !== ''} />;
          }}
          options={groups.map((group) => ({
            label: group.label,
            title: group.label,
            options: group.options.map((option) => ({
              value: option.value,
              disabled: option.disabled,
              label: (
                <OptionRow
                  name={option.name}
                  hint={option.hint}
                  mono={option.value !== ''}
                  reason={option.disabled}
                />
              ),
            })),
          }))}
        />
      </ModelTestRow>
      {state.kind === 'unknown' ? <UnknownNote value={state.value} /> : null}
      {state.kind === 'tierMap' ? <TierMapNote summary={state.summary} /> : null}
    </div>
  );
}

function OptionRow({
  name,
  hint,
  mono,
  reason,
}: {
  name: string;
  hint: string;
  mono: boolean;
  reason?: boolean;
}) {
  return (
    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>
      <span style={mono ? { ...ELLIPSIS, ...MONO } : ELLIPSIS}>{name}</span>
      <Typography.Text type="secondary" style={{ ...ELLIPSIS, fontSize: 12 }}>
        {reason ? '✗ ' : ''}
        {hint}
      </Typography.Text>
    </span>
  );
}

function UnknownNote({ value }: { value: string }) {
  const note = unknownDeclarationNote(value);
  const rest = note.slice(value.length);
  return (
    <Typography.Text type="secondary" style={NOTE_STYLE}>
      <ExclamationCircleOutlined style={{ color: 'var(--ethos-warning)', marginRight: 4 }} />
      <span style={MONO}>{value}</span>
      {rest}
    </Typography.Text>
  );
}

function TierMapNote({ summary }: { summary: string }) {
  return (
    <Typography.Text type="secondary" style={NOTE_STYLE}>
      {tierMapNote(summary)}
    </Typography.Text>
  );
}

/** The picker and its Test button share one row; the detail, outcome and
 *  failure render BELOW it. Inside the non-wrapping row a full-width detail
 *  squeezed the Select to a sliver. */
function ModelTestRow({
  target,
  children,
}: {
  target: ReturnType<typeof resolveTestTarget>;
  children: ReactNode;
}) {
  const [cooldown, setCooldown] = useState(0);
  const [result, setResult] = useState<{
    alias: string;
    outcome: ModelRegistryTestResult;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const testMut = useMutation({
    mutationFn: (alias: string) => rpc.modelRegistry.test({ alias }),
    onMutate: () => setFailure(null),
    onSuccess: (outcome, alias) => setResult({ alias, outcome }),
    onError: (err) => setFailure(err.message),
    onSettled: () => setCooldown(TEST_COOLDOWN_SECONDS),
  });

  const disabled = !target.ok || cooldown > 0 || testMut.isPending;
  // An outcome belongs to the alias it tested; a new selection resolving
  // elsewhere must not keep showing the old verdict.
  const shown = target.ok && result?.alias === target.alias ? result.outcome : null;

  let detail: ReactNode = null;
  if (!target.ok) detail = target.reason;
  else if (target.note) detail = target.note;

  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {children}
        <Button
          disabled={disabled}
          loading={testMut.isPending}
          onClick={() => {
            if (target.ok) testMut.mutate(target.alias);
          }}
        >
          {cooldown > 0 ? `Test (${cooldown}s)` : 'Test'}
        </Button>
      </div>
      {detail || shown || failure ? (
        <div>
          {detail ? (
            <Typography.Text type="secondary" style={NOTE_STYLE}>
              {detail}
            </Typography.Text>
          ) : null}
          {shown ? <ModelTestOutcome outcome={shown} /> : null}
          {failure ? (
            <Typography.Text type="danger" style={NOTE_STYLE}>
              Test failed: {failure}
            </Typography.Text>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
