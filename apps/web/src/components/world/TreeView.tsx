import type { TreeGroup } from './types';

export function TreeView({
  groups,
  onOpen,
}: {
  groups: readonly TreeGroup[];
  onOpen: (entityId: string) => void;
}) {
  if (groups.length === 0) return <p className="world-empty">No entities yet.</p>;
  return (
    <div className="world-tree">
      {groups.map((g) => (
        <section key={g.type}>
          <h3 className="world-micro">
            {g.type} <span className="world-dim">{g.entities.length}</span>
          </h3>
          <ul className="world-rows">
            {g.entities.map((e) => (
              <li key={e.id}>
                <button type="button" className="world-row" onClick={() => onOpen(e.id)}>
                  <span>{e.name}</span>
                  {e.isNew ? <span className="world-pill">new</span> : null}
                  <span className="world-small world-mono">{e.edgeCount} links</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
