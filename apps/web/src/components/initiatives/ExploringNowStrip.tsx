import { useExploringNow } from '../../features/initiatives/api/queries';
import { formatUsd } from '../../lib/usage-format';

/**
 * "Exploring now" strip for the chat header: the running window, its cost so
 * far, and a read-only label. Renders nothing when no window is running.
 */
export function ExploringNowStrip({ personalityId }: { personalityId: string }) {
  const { data } = useExploringNow(personalityId);
  const current = data?.current;
  if (!current) return null;
  return (
    <span className="exploring-now" data-testid="exploring-now">
      <span className="exploring-now-dot" aria-hidden="true" />
      <span>Exploring now</span>
      <span className="initiative-muted">
        {current.initiativeTitle} · window {current.windowId}
      </span>
      <span className="initiative-mono">{formatUsd(current.costSoFarUsd)} so far</span>
      <span className="exploring-now-readonly">read-only</span>
    </span>
  );
}
