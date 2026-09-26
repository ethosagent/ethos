import { useEffect, useRef, useState } from 'react';
import type { TurnPhase } from '../../lib/chat-reducer';
import { formatDuration } from '../../lib/trail';

// The status line — feedback & activity contract §2, DESIGN.md "Feedback &
// activity". It sits directly above the composer, inside the 800px column, in
// a slot that is reserved from the moment a message is sent, so the phases
// change without anything moving.
//
// It replaces `TurnStatusBar` from `@ethosagent/ui-components`, which was 12px
// `system-ui` with a 2 s ease-out — three DESIGN.md violations. Here: Geist
// Mono 13px `--text-secondary`, elapsed in `--text-tertiary` tabular, and the
// only transition is opacity at `--motion-default`.
//
// It also absorbs the old separate "Still working…" notice: two stall
// indicators on one screen is one too many.

/** One announcement per 2 s, however fast the tools churn (contract §2). */
export const ANNOUNCE_THROTTLE_MS = 2_000;

export interface StatusLineProps {
  /** Null when no turn is in flight — the line (and its slot) is not drawn. */
  phase: TurnPhase | null;
  /** The tool line (`{tool} · {argsPreview}`) or a user-audience progress
   *  message. Null falls back to the phase's own word. */
  label: string | null;
  elapsedMs: number;
  /** No event for 20 s. Appends `⚠ still working` — glyph AND word. */
  stalled: boolean;
  /**
   * A5 — a capped preview of the turn's extended reasoning. While the phase is
   * `thinking` the line reads `thinking ▸ "<first 60 chars>…"` — the status
   * slot, never the bubble (DESIGN.md item 1). The live region still announces
   * only the word `thinking`, so a screen reader is not fed rolling prose.
   */
  thinking?: string | null;
  /** W2 — the SSE stream dropped mid-turn; appends `reconnecting…`. */
  reconnecting?: boolean;
  /** W2 — the browser gave up on the stream (`closed`); appends
   *  `connection lost` — only a reload (fresh subscribe) reopens it. */
  connectionLost?: boolean;
}

/** How much of the thinking preview the collapsed line shows. */
const THINKING_PREVIEW_CHARS = 60;

function thinkingLabel(preview: string): string {
  const head = preview.slice(0, THINKING_PREVIEW_CHARS);
  const ellipsis = preview.length > THINKING_PREVIEW_CHARS ? '…' : '';
  return `thinking ▸ "${head}${ellipsis}"`;
}

/** The words are the feedback — no spinner vocabulary, no percentages. */
function phaseWord(phase: TurnPhase): string {
  if (phase === 'received') return 'received';
  if (phase === 'thinking') return 'thinking';
  if (phase === 'writing') return 'writing';
  if (phase === 'decision') return 'checking';
  return 'working';
}

export function StatusLine({
  phase,
  label,
  elapsedMs,
  stalled,
  thinking,
  reconnecting,
  connectionLost,
}: StatusLineProps) {
  // A running tool is the only pulsing state; `received` and `thinking` are
  // steady.
  // An `on` decision holding the loop (`jev checking read_file result`) is
  // steady: the loop is waiting, not running a tool.
  const labelled = phase === 'tool' || phase === 'decision';
  const base = phase === null ? '' : labelled ? (label ?? phaseWord(phase)) : phaseWord(phase);
  // The visible text carries the reasoning preview; announcements never do
  // (`base` below), so the throttle governs words, not rolling prose.
  const text = phase === 'thinking' && thinking ? thinkingLabel(thinking) : base;
  // A new turn is never made to wait behind the previous turn's throttle
  // window: `received` IS the acknowledgement the contract promises within the
  // first second. `phase === null` is the turn ending, which re-arms the
  // throttle (and announces nothing — the region is not rendered).
  const announced = useThrottledAnnouncement(base, phase === null || phase === 'received');

  if (phase === null) return null;

  return (
    <div className="status-line activity-slot">
      <span
        className={`sb-dot status-line-dot${phase === 'tool' ? ' sb-dot--pulse' : ''}${
          phase === 'decision' ? ' status-line-dot--decision' : ''
        }`}
        aria-hidden="true"
      />
      <span className="status-line-label" aria-hidden="true">
        {text}
      </span>
      {connectionLost ? (
        <span className="status-line-stall" aria-hidden="true">
          connection lost
        </span>
      ) : reconnecting ? (
        <span className="status-line-stall" aria-hidden="true">
          reconnecting…
        </span>
      ) : null}
      {stalled ? (
        <span className="status-line-stall" aria-hidden="true">
          ⚠ still working
        </span>
      ) : null}
      <span className="status-line-elapsed" aria-hidden="true">
        {elapsedMs > 0 ? formatDuration(elapsedMs) : ''}
      </span>
      {/* The live region itself. Kept separate from the visible text so the
          throttle governs ANNOUNCEMENTS only — the eye still sees each phase
          the moment it changes. */}
      <span className="activity-sr" role="status" aria-live="polite">
        {announced}
      </span>
    </div>
  );
}

/**
 * Emit `text` at most once per `ANNOUNCE_THROTTLE_MS`. A change inside the
 * window is not dropped — it lands when the window closes, so the last state
 * is always the announced one.
 *
 * `immediate` bypasses the window for the first announcement of a turn, and
 * re-arms it when the turn ends, so the throttle is per-turn rather than
 * per-session.
 */
function useThrottledAnnouncement(text: string, immediate: boolean): string {
  const [announced, setAnnounced] = useState(text);
  const lastAtRef = useRef(0);

  useEffect(() => {
    if (immediate) {
      // An empty text is the turn ending — nothing to announce, and the next
      // turn's first phase must not be charged for this one.
      lastAtRef.current = text === '' ? 0 : Date.now();
      setAnnounced(text);
      return;
    }
    const since = Date.now() - lastAtRef.current;
    if (since >= ANNOUNCE_THROTTLE_MS) {
      lastAtRef.current = Date.now();
      setAnnounced(text);
      return;
    }
    const id = setTimeout(() => {
      lastAtRef.current = Date.now();
      setAnnounced(text);
    }, ANNOUNCE_THROTTLE_MS - since);
    return () => clearTimeout(id);
  }, [text, immediate]);

  return announced;
}
