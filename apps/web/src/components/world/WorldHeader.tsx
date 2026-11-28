import type { WorldSummary } from './types';
import { isInertMount } from './world-logic';

/**
 * Audience plus every personality that mounts the world, with the mode it
 * actually gets. A mount whose effective mode differs from the requested one,
 * or that carries a note, is shown as inert with the reason.
 */
export function WorldHeader({ world }: { world: WorldSummary }) {
  return (
    <header className="world-header">
      <div className="world-title-row">
        <h2 className="world-title">{world.title}</h2>
        <span className="world-pill" data-audience={world.audience}>
          {world.audience === 'owner_only' ? 'owner only' : 'shareable'}
        </span>
        <span className="world-small world-mono">
          {world.counts.entities} entities · {world.counts.liveEdges} links
          {world.counts.pendingProposals > 0 ? ` · ${world.counts.pendingProposals} pending` : ''}
        </span>
      </div>
      <div className="world-mounts">
        <span className="world-micro">mounted by</span>
        {world.mountedBy.length === 0 ? (
          <span className="world-small">No personality mounts this world.</span>
        ) : (
          <ul className="world-mount-list">
            {world.mountedBy.map((m) => (
              <li key={m.personalityId} data-inert={isInertMount(m) ? 'true' : 'false'}>
                <span className="world-mono">{m.personalityId}</span>{' '}
                <span className="world-small">
                  {m.effective}
                  {m.effective !== m.mode ? ` (asked ${m.mode})` : ''}
                </span>
                {isInertMount(m) ? (
                  <span className="world-inert"> inert{m.note ? `: ${m.note}` : ''}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </header>
  );
}
