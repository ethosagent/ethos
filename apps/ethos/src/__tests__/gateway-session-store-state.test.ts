import { describe, expect, it, vi } from 'vitest';
import { closeSlackSessionStores } from '../commands/gateway';
import { slackSessionStores } from '../commands/gateway-platform-readers';

// `slackSessionStores` lives in gateway-platform-readers.ts (the readers add
// to it); `closeSlackSessionStores` stays in gateway.ts (it also closes the
// branch and spend handles). They must see ONE Set, or a Slack reader's handle
// outlives the gateway's shutdown.
describe('slackSessionStores — one owner, shared with the shutdown close', () => {
  it('closeSlackSessionStores closes and clears what a reader registered', () => {
    const close = vi.fn();
    slackSessionStores.add({ close });
    closeSlackSessionStores();
    expect(close).toHaveBeenCalledTimes(1);
    expect(slackSessionStores.size).toBe(0);
  });
});
