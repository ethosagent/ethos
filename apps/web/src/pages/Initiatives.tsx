import { type CSSProperties, useState } from 'react';
import { useParams } from 'react-router-dom';
import { InitiativeDetail } from '../components/initiatives/InitiativeDetail';
import {
  AGENT_BADGE_ACCENT,
  FILTERS,
  type InitiativeFilter,
  matchesFilter,
} from '../components/initiatives/model';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingState } from '../components/ui/LoadingState';
import { useInitiativeList } from '../features/initiatives/api/queries';
import { formatUsd } from '../lib/usage-format';

// Initiatives: a read-only window onto the initiative engine. Nothing here edits
// an initiative; to change one the user tells the agent in chat. The only writes
// are decisions (initiatives.decide). Not the Card primitive: rows are dense lists.
export function Initiatives() {
  const { personalityId } = useParams<{ personalityId?: string }>();
  const list = useInitiativeList(personalityId);
  const [filter, setFilter] = useState<InitiativeFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);

  if (list.isLoading) return <LoadingState label="Loading initiatives…" />;
  if (list.error) {
    return (
      <div role="alert" className="initiative-error">
        {list.error instanceof Error ? list.error.message : 'Could not load initiatives.'}
      </div>
    );
  }
  const items = (list.data?.items ?? []).filter((i) => matchesFilter(i, filter));

  return (
    <div className="initiatives-page">
      <div className="initiatives-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            data-filter={f.key}
            aria-pressed={filter === f.key}
            className={`initiatives-filter${filter === f.key ? ' initiatives-filter-on' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="initiatives-body">
        <div className="initiatives-list">
          {items.length === 0 ? (
            <EmptyState
              title="No initiatives here."
              hint="Ask the agent in chat to start one, or let it propose its own."
            />
          ) : null}
          {items.map((i) => (
            <button
              key={i.id}
              type="button"
              data-initiative-id={i.id}
              aria-current={selected === i.id}
              className={`initiatives-item${selected === i.id ? ' initiatives-item-on' : ''}`}
              onClick={() => setSelected(i.id)}
            >
              <span className="initiatives-item-title">{i.title ?? `${i.id} (invalid file)`}</span>
              <span className="initiatives-item-meta">
                <span
                  className={`initiative-badge initiative-badge-${i.origin}`}
                  data-origin-badge={i.origin}
                  style={
                    i.origin === 'agent'
                      ? ({ '--initiative-agent': AGENT_BADGE_ACCENT } as CSSProperties)
                      : undefined
                  }
                >
                  {i.origin === 'agent' ? 'Agent' : 'You'}
                </span>
                <span>{i.state}</span>
                <span className="initiative-mono">{formatUsd(i.spendTodayUsd)} today</span>
              </span>
            </button>
          ))}
        </div>
        <div className="initiatives-pane">
          {selected ? (
            <InitiativeDetail key={selected} id={selected} />
          ) : (
            <div className="initiative-muted">
              Select an initiative to see its file and activity.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
