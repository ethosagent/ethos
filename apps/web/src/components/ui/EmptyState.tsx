// N5c (plan ux-feedback-and-config-clarity) — the one empty block. DESIGN.md
// §Voice: empty states are PRACTICAL — say what would put something here, in
// in-product language, never "Looks like you don't have any X yet! 🚀". Left
// aligned (centered-everything is on the anti-slop table); no Card, no icon
// circle — typography does the work.

import type { ReactNode } from 'react';
import './state-blocks.css';

export function EmptyState({
  title,
  hint,
  action,
}: {
  /** The fact: "Nothing queued.", "No pending memory." */
  title: string;
  /** What puts something here — a concrete next step, not encouragement. */
  hint?: ReactNode;
  /** Optional verb button ("Add provider"), rendered under the hint. */
  action?: ReactNode;
}) {
  return (
    <div className="state-empty">
      <div className="state-empty-title">{title}</div>
      {hint ? <div className="state-empty-hint">{hint}</div> : null}
      {action ? <div className="state-empty-action">{action}</div> : null}
    </div>
  );
}
