import type { InitiativeWindowViewSchema } from '@ethosagent/web-contracts';
import type { z } from 'zod';
import { formatUsd } from '../../lib/usage-format';

type WindowView = z.infer<typeof InitiativeWindowViewSchema>;

/** Every window the initiative has run: when, tools, reads, findings, cost. */
export function ActivityList({ windows }: { windows: WindowView[] }) {
  if (windows.length === 0) {
    return <div className="initiative-muted">No windows have run yet.</div>;
  }
  return (
    <ul className="initiative-activity">
      {windows.map((w) => (
        <li key={w.id} data-window-id={w.id} className="initiative-window">
          <span className="initiative-mono">{new Date(w.started).toLocaleString()}</span>
          <span>{w.kind}</span>
          <span className="initiative-mono">{w.tools.join(', ') || 'no tools'}</span>
          <span className="initiative-mono">
            {w.reads.length > 0 ? w.reads.join(', ') : 'no reads'}
          </span>
          <span>
            {w.findings} {w.findings === 1 ? 'finding' : 'findings'}
          </span>
          <span className="initiative-mono">{formatUsd(w.costUsd)}</span>
        </li>
      ))}
    </ul>
  );
}
