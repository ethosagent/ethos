import type { EntityDetail, EntityFact } from './types';
import { isInertMount } from './world-logic';

function showValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value);
  return json === undefined ? '' : json;
}

function span(from: string | null, to: string | null): string {
  return `${from?.slice(0, 10) ?? '?'} to ${to?.slice(0, 10) ?? 'now'}`;
}

interface TimelineRow {
  at: string;
  text: string;
}

/** Facts and links, oldest first; undated rows sort by when they were recorded. */
export function timelineRows(e: EntityDetail): TimelineRow[] {
  const rows: TimelineRow[] = [
    ...e.facts.map((f) => ({
      at: f.validFrom ?? f.recordedAt,
      text: `${f.key} = ${showValue(f.value)}`,
    })),
    ...e.edges.map((x) => ({
      at: x.validFrom ?? '',
      text: `${x.direction === 'out' ? '→' : '←'} ${x.type} ${x.otherName}`,
    })),
  ];
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

export function EntityPage({
  entity,
  onPromote,
  onOpen,
  promoting,
}: {
  entity: EntityDetail;
  onPromote: (fact: EntityFact) => void;
  onOpen: (entityId: string) => void;
  promoting: boolean;
}) {
  return (
    <article className="world-entity">
      <h2 className="world-title">
        {entity.name} <span className="world-pill">{entity.type}</span>
      </h2>
      {entity.aliases.length > 0 ? (
        <p className="world-small">Also known as {entity.aliases.join(', ')}</p>
      ) : null}
      {entity.retiredAt ? (
        <p className="world-small">Retired {entity.retiredAt.slice(0, 10)}</p>
      ) : null}

      <h3 className="world-micro">Facts</h3>
      {entity.facts.length === 0 ? (
        <p className="world-empty">No facts recorded.</p>
      ) : (
        <ul className="world-rows">
          {entity.facts.map((f) => (
            <li key={f.id} className="world-fact">
              <div>
                <span className="world-mono">{f.key}</span> {showValue(f.value)}
              </div>
              <div className="world-small world-dim">
                {span(f.validFrom, f.validTo)} · source {f.sourceRef} · by {f.author}
              </div>
              {f.promotable ? (
                <button
                  type="button"
                  className="world-btn"
                  disabled={promoting}
                  onClick={() => onPromote(f)}
                >
                  Make it yours
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3 className="world-micro">Links</h3>
      <ul className="world-rows">
        {entity.edges.map((x) => (
          <li key={x.id} className="world-line" data-ended={x.validTo ? 'true' : 'false'}>
            <span className="world-dim">{x.direction === 'out' ? '→' : '←'}</span>
            <span className="world-mono">{x.type}</span>
            <button type="button" className="world-link" onClick={() => onOpen(x.otherId)}>
              {x.otherName}
            </button>
            <span className="world-small world-dim">
              {span(x.validFrom, x.validTo)} · by {x.author}
            </span>
          </li>
        ))}
      </ul>

      <h3 className="world-micro">Timeline</h3>
      <ol className="world-rows">
        {timelineRows(entity).map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are derived, ordered and never reordered in place
          <li key={i} className="world-line">
            <span className="world-mono world-dim">{r.at.slice(0, 10) || 'undated'}</span>
            <span>{r.text}</span>
          </li>
        ))}
      </ol>

      <h3 className="world-micro">Memory notes</h3>
      {entity.memoryMentions.length === 0 ? (
        <p className="world-empty">No memory note mentions this entity.</p>
      ) : (
        <ul className="world-rows">
          {entity.memoryMentions.map((m) => (
            <li key={`${m.scope}:${m.excerpt}`}>
              <span className="world-small world-dim">{m.scope}</span> {m.excerpt}
            </li>
          ))}
        </ul>
      )}

      <h3 className="world-micro">Mounted by</h3>
      <ul className="world-rows">
        {entity.mountedBy.map((m) => (
          <li key={m.personalityId}>
            <span className="world-mono">{m.personalityId}</span> {m.effective}
            {isInertMount(m) ? ` (inert${m.note ? `: ${m.note}` : ''})` : ''}
          </li>
        ))}
      </ul>
    </article>
  );
}
