// The small shared pieces of Settings → Models' registry sections: a status
// word, a refusal, a validator problem, a referent, a Test button. Status
// colour always travels with its glyph (DESIGN.md), and every literal the
// operator also reads in config.yaml is Geist Mono.

import type {
  ModelReferent,
  ModelRegistryProblemView,
  ModelRegistryRefusal,
} from '@ethosagent/web-contracts';
import { Button, Tooltip } from 'antd';
import type { CSSProperties } from 'react';
import {
  referentParts,
  type StatusTone,
  type StatusView,
  type TestButtonState,
} from '../lib/model-registry';

export const MONO: CSSProperties = {
  fontFamily: 'var(--font-mono, "Geist Mono", monospace)',
  fontVariantNumeric: 'tabular-nums',
};

export const SUB: CSSProperties = { display: 'block', fontSize: 12, color: 'var(--text-tertiary)' };

export const MICRO: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
};

export const TOOLBAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  flexWrap: 'wrap',
  marginBottom: 8,
};

const TONE_COLOR: Record<StatusTone, string> = {
  ok: 'var(--success)',
  err: 'var(--error)',
  warn: 'var(--warning)',
  muted: 'var(--text-tertiary)',
};

/** `wrap` lets a long status (`⚠ could not reach …`) break at spaces rather than widen its cell. */
export function StatusText({ view, wrap = false }: { view: StatusView; wrap?: boolean }) {
  return (
    <span
      title={view.title ?? undefined}
      style={{ fontSize: 12, whiteSpace: wrap ? 'normal' : 'nowrap', color: TONE_COLOR[view.tone] }}
    >
      {view.text}
    </span>
  );
}

export function ProblemLines({ problems }: { problems: readonly ModelRegistryProblemView[] }) {
  return (
    <ul
      style={{
        margin: 0,
        padding: 0,
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {problems.map((p) => (
        <li key={`${p.code}:${p.key}:${p.alias}`} style={{ fontSize: 13 }}>
          <span style={{ color: 'var(--warning)' }}>⚠ </span>
          {p.message}
          {p.fix ? (
            <span style={SUB}>
              Fix: <span style={MONO}>{p.fix}</span>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * A refusal VALUE from a registry write, rendered verbatim where it happened.
 * Model writes (`ModelRegistryRefusal`) and provider writes
 * (`ModelRegistryProviderRefusal`) share the two fields drawn here.
 */
export function RefusalNotice({
  refusal,
}: {
  refusal: Pick<ModelRegistryRefusal, 'message' | 'problems'>;
}) {
  return (
    <div
      role="alert"
      className="model-registry-refusal"
      style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, margin: '8px 0' }}
    >
      <span>
        <span style={{ color: 'var(--error)' }}>✗ </span>
        {refusal.message}
      </span>
      {refusal.problems.length > 0 ? <ProblemLines problems={refusal.problems} /> : null}
    </div>
  );
}

export function ReferentItem({ referent }: { referent: ModelReferent }) {
  const parts = referentParts(referent);
  return (
    <li>
      {parts.before}
      {parts.name !== null ? <span style={MONO}>{parts.name}</span> : null}
      {parts.after}
    </li>
  );
}

export function TestButton({
  state,
  loading,
  onClick,
}: {
  state: TestButtonState;
  loading: boolean;
  onClick: () => void;
}) {
  const button = (
    <Button size="small" disabled={state.disabled} loading={loading} onClick={onClick}>
      {state.label}
    </Button>
  );
  // A disabled button swallows pointer events, so the tooltip hangs off a span.
  return state.reason ? (
    <Tooltip title={state.reason}>
      <span>{button}</span>
    </Tooltip>
  ) : (
    button
  );
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
