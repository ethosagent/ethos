import { useMemo, useState } from 'react';
import { CytoCanvas } from './CytoCanvas';
import { DateSlider } from './DateSlider';
import type { GraphEdge, GraphNode } from './types';
import { buildElements, dateBounds, opensOnSearch, searchNodes, visibleEdges } from './world-logic';

export interface SearchEntry {
  id: string;
  name: string;
  type: string;
}

export function GraphView({
  entityCount,
  nodes,
  edges,
  searchIndex,
  focus,
  hops,
  asOf,
  onFocus,
  onHops,
  onAsOf,
  onOpen,
}: {
  entityCount: number;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  /** Every entity name in the world (from `worlds.tree`), for the search entry. */
  searchIndex: readonly SearchEntry[];
  focus: string | null;
  hops: number;
  asOf: string | null;
  onFocus: (id: string | null) => void;
  onHops: (hops: number) => void;
  onAsOf: (date: string | null) => void;
  onOpen: (entityId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [showEnded, setShowEnded] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const visible = useMemo(() => visibleEdges(edges, asOf, showEnded), [edges, asOf, showEnded]);
  const elements = useMemo(() => buildElements(nodes, visible, hidden), [nodes, visible, hidden]);
  const types = useMemo(() => [...new Set(nodes.map((n) => n.type))].sort(), [nodes]);

  // A big world opens on search; once something is focused the focused slice is small.
  if (opensOnSearch(entityCount) && focus === null) {
    const hits = searchNodes(searchIndex, query);
    return (
      <div className="world-search">
        <p className="world-small">
          This world has {entityCount} entities. Search for one to see its neighbourhood.
        </p>
        <input
          type="search"
          className="world-input"
          aria-label="Search entities"
          placeholder="Search entities"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="world-rows">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" className="world-row" onClick={() => onFocus(h.id)}>
                <span>{h.name}</span>
                <span className="world-small world-dim">{h.type}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div>
      <div className="world-toolbar">
        {types.map((t) => (
          <label key={t} className="world-check">
            <input
              type="checkbox"
              checked={!hidden.has(t)}
              onChange={() =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(t)) next.add(t);
                  return next;
                })
              }
            />
            {t}
          </label>
        ))}
        <label className="world-check">
          <input
            type="checkbox"
            checked={showEnded}
            onChange={(e) => setShowEnded(e.target.checked)}
          />
          Show ended links
        </label>
        {focus !== null ? (
          <>
            <label className="world-check">
              hops
              <select value={hops} onChange={(e) => onHops(Number(e.target.value))}>
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </label>
            <button type="button" className="world-btn" onClick={() => onFocus(null)}>
              Clear focus
            </button>
          </>
        ) : null}
      </div>
      <DateSlider bounds={dateBounds(edges)} value={asOf} onChange={onAsOf} />
      {elements.nodes.length === 0 ? (
        <p className="world-empty">Nothing to draw yet.</p>
      ) : (
        <CytoCanvas elements={elements} onOpen={onOpen} />
      )}
    </div>
  );
}
