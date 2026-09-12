import type { AgentBridge } from '@ethosagent/agent-bridge';
import type { AgentLoop } from '@ethosagent/core';

/** What the host's `rebuildLoop` hands back for a `/model` switch. */
export interface RebuiltLoop {
  loop: AgentLoop;
  /**
   * Release the runtime `loop` replaces — its `CreateAgentLoopResult.dispose`.
   * Absent when the host has nothing to release.
   */
  retirePrevious?: () => Promise<void>;
}

/**
 * F06 — swap the bridge onto the rebuilt loop at once, then retire the runtime
 * it replaced once the turn still running on it (if any) has finished: a
 * dispose mid-turn would pull the stores and MCP clients out from under that
 * turn. Resolves when the old runtime is released. Pinned by
 * apps/tui/src/__tests__/loop-switch.test.ts.
 */
export async function switchLoop(bridge: AgentBridge, next: RebuiltLoop): Promise<void> {
  bridge.replaceLoop(next.loop);
  await bridge.whenIdle();
  await next.retirePrevious?.();
}
