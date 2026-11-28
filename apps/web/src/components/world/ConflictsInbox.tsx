import { useState } from 'react';
import type { Proposal } from './types';

/** Conflicting proposals first; the rest keep the server's order (newest first). */
export function conflictsFirst(proposals: readonly Proposal[]): Proposal[] {
  const conflicts = proposals.filter((p) => p.conflictWith !== null);
  const rest = proposals.filter((p) => p.conflictWith === null);
  return [...conflicts, ...rest];
}

export function ConflictsInbox({
  proposals,
  busy,
  onDecide,
}: {
  proposals: readonly Proposal[];
  busy: boolean;
  onDecide: (ids: string[], verdict: 'accept' | 'reject') => void;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const ordered = conflictsFirst(proposals);
  if (ordered.length === 0) return <p className="world-empty">No proposals waiting.</p>;
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const ids = [...picked];
  return (
    <div>
      <div className="world-toolbar">
        <span className="world-small">{picked.size} selected</span>
        <button
          type="button"
          className="world-btn"
          disabled={busy || picked.size === 0}
          onClick={() => onDecide(ids, 'accept')}
        >
          Accept selected
        </button>
        <button
          type="button"
          className="world-btn"
          disabled={busy || picked.size === 0}
          onClick={() => onDecide(ids, 'reject')}
        >
          Reject selected
        </button>
      </div>
      <ul className="world-rows">
        {ordered.map((p) => (
          <li
            key={p.id}
            className="world-proposal"
            data-conflict={p.conflictWith ? 'true' : 'false'}
          >
            <input
              type="checkbox"
              aria-label={`Select ${p.summary}`}
              checked={picked.has(p.id)}
              onChange={() => toggle(p.id)}
            />
            <div className="world-proposal-body">
              <div>
                {p.conflictWith ? <span className="world-conflict">Conflict </span> : null}
                {p.summary}
              </div>
              <div className="world-small world-dim">
                {p.kind} · {p.sourceRef} · by {p.proposedBy} · confidence {p.confidence.toFixed(2)}
                {p.conflictWith ? ` · contradicts ${p.conflictWith}` : ''}
              </div>
            </div>
            <button
              type="button"
              className="world-btn"
              disabled={busy}
              onClick={() => onDecide([p.id], 'accept')}
            >
              Accept
            </button>
            <button
              type="button"
              className="world-btn"
              disabled={busy}
              onClick={() => onDecide([p.id], 'reject')}
            >
              Reject
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
