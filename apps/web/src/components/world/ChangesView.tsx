import type { ChangeGroup } from './types';

export function ChangesView({
  groups,
  since,
  onSince,
}: {
  groups: readonly ChangeGroup[];
  since: string;
  onSince: (date: string) => void;
}) {
  return (
    <div>
      <label className="world-field">
        <span className="world-micro">since</span>
        <input
          type="date"
          className="world-input"
          value={since}
          onChange={(e) => e.target.value && onSince(e.target.value)}
        />
      </label>
      {groups.length === 0 ? (
        <p className="world-empty">Nothing changed since {since}.</p>
      ) : (
        groups.map((g) => (
          <section key={`${g.sourceRef}:${g.author}`} className="world-group">
            <h3 className="world-micro">
              {g.sourceRef} <span className="world-dim">by {g.author}</span>
            </h3>
            <ul className="world-rows">
              {g.changes.map((c) => (
                <li key={`${c.factId}:${c.kind}:${c.at}`} className="world-line">
                  <span className="world-mono world-dim">{c.at.slice(0, 10)}</span>
                  <span className="world-pill">{c.kind}</span>
                  <span>{c.summary}</span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
