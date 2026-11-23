import type { ContextAnatomyWire } from '@ethosagent/web-contracts';
import { Button, Popover } from 'antd';
import type { ReactNode } from 'react';
import { contextAnatomyRows, formatWindow } from '../../lib/context-anatomy-rows';
import { formatContextTokens } from '../../lib/format-context-tokens';

// The composer's context meter: a 20px ring + percent of the model's window,
// opening a popover with the per-section breakdown and a Compact now button.
// Warning and over carry a ⚠ glyph and an aria-label sentence — never colour
// alone (DESIGN.md). No card, no animation.

type MeterState = 'normal' | 'warning' | 'over';

export interface ContextMeterProps {
  anatomy: ContextAnatomyWire | null;
  /** Live context size (last usage event / post-compact estimate); falls back to the anatomy's. */
  usedTokens: number | null;
  compactDisabled: boolean;
  onCompact: () => void;
}

/** over at/after the auto-compaction point, warning from 90% of it. */
export function meterState(used: number, compactAt: number | null): MeterState {
  if (compactAt === null) return 'normal';
  if (used >= compactAt) return 'over';
  if (used >= 0.9 * compactAt) return 'warning';
  return 'normal';
}

const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function pctOf(n: number, window: number): number {
  return window > 0 ? Math.round((n / window) * 100) : 0;
}

function Ring({ fraction, state }: { fraction: number; state: MeterState }) {
  const arc = Math.min(1, Math.max(0, fraction)) * RING_CIRCUMFERENCE;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle
        cx="10"
        cy="10"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        style={{ stroke: 'var(--border-subtle)' }}
      />
      <circle
        cx="10"
        cy="10"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        strokeDasharray={`${arc} ${RING_CIRCUMFERENCE}`}
        transform="rotate(-90 10 10)"
        style={{ stroke: state === 'normal' ? 'var(--text-secondary)' : 'var(--warning)' }}
      />
    </svg>
  );
}

interface ContextMeterPanelProps {
  anatomy: ContextAnatomyWire;
  used: number;
  compactDisabled: boolean;
  onCompact: () => void;
}

/** Popover body: stacked bar, five rows, cache hit, Compact now. */
export function ContextMeterPanel({
  anatomy,
  used,
  compactDisabled,
  onCompact,
}: ContextMeterPanelProps) {
  const rows = contextAnatomyRows(anatomy);
  const window = anatomy.contextWindow;
  const basis = window ?? rows.reduce((sum, r) => sum + r.tokens, 0);
  const over = meterState(used, anatomy.compactAtTokens) === 'over';
  const tickPct =
    window !== null && anatomy.compactAtTokens !== null
      ? Math.min(100, (anatomy.compactAtTokens / window) * 100)
      : null;
  return (
    <div className="context-meter-panel">
      <div className="context-meter-bar">
        {rows.map((r) => (
          <span
            key={r.key}
            className={`context-meter-seg context-meter-seg-${r.key}`}
            style={{ width: `${basis > 0 ? (r.tokens / basis) * 100 : 0}%` }}
          />
        ))}
        {tickPct !== null ? (
          <span
            className="context-meter-tick"
            style={{ left: `${tickPct}%` }}
            title="auto-compacts here"
          />
        ) : null}
      </div>
      <dl className="context-meter-rows">
        {rows.map((r) => (
          <div key={r.key} className="context-meter-row">
            <dt>{r.approx ? `≈ ${r.label}` : r.label}</dt>
            <dd>{formatContextTokens(r.tokens)}</dd>
            <dd className="context-meter-row-pct">
              {window !== null ? `${pctOf(r.tokens, window)}% of window` : ''}
            </dd>
          </div>
        ))}
      </dl>
      <p className="context-meter-note">Cache hit {Math.round(anatomy.cacheHitRate * 100)}%</p>
      {over ? (
        <p className="context-meter-note">
          Past the auto-compaction point — the next turn compacts unless one ran in the last 5
          turns.
        </p>
      ) : null}
      <p className="context-meter-foot">
        Memory/skills ≈ by size share. Skills loaded on demand count under Messages.
      </p>
      <p className="context-meter-foot">Focused compaction: type /compact &lt;focus&gt;</p>
      <Button size="small" disabled={compactDisabled} onClick={() => onCompact()}>
        Compact now
      </Button>
    </div>
  );
}

export function ContextMeter({
  anatomy,
  usedTokens,
  compactDisabled,
  onCompact,
}: ContextMeterProps) {
  if (!anatomy) {
    if (!usedTokens) return null;
    return <span className="composer-context-meter">{formatContextTokens(usedTokens)} tokens</span>;
  }
  const used = usedTokens ?? anatomy.promptTokens;
  const state = meterState(used, anatomy.compactAtTokens);
  const panel = (
    <ContextMeterPanel
      anatomy={anatomy}
      used={used}
      compactDisabled={compactDisabled}
      onCompact={onCompact}
    />
  );

  const qualifiers: Record<MeterState, string> = {
    normal: '',
    warning: ', near auto-compaction',
    over: ', past auto-compaction point',
  };
  const window = anatomy.contextWindow;
  let ariaLabel: string;
  let inner: ReactNode;
  if (window === null) {
    ariaLabel = `Context: ${formatContextTokens(used)} tokens`;
    inner = <span className="context-meter-pct">{formatContextTokens(used)} tokens</span>;
  } else {
    const pct = pctOf(used, window);
    ariaLabel = `Context: ${pct}% of ${formatWindow(window)} used${qualifiers[state]}`;
    inner = (
      <>
        <Ring fraction={used / window} state={state} />
        <span className="context-meter-pct">{state === 'normal' ? `${pct}%` : `⚠ ${pct}%`}</span>
      </>
    );
  }
  return (
    <Popover trigger="click" placement="topRight" content={panel}>
      <button type="button" className="context-meter" aria-label={ariaLabel}>
        {inner}
      </button>
    </Popover>
  );
}
