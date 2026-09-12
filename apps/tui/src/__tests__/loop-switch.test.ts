/**
 * F06 follow-up — the TUI `/model` switch rebuilds the agent loop. Before this
 * the host kept only the new `.loop` and dropped the runtime it replaced, so
 * every switch leaked a background executor (three intervals), MCP children,
 * plugins and open sessions.db / jobs.db / goals.db handles. `switchLoop` swaps
 * the bridge onto the new loop at once and retires the old runtime only once
 * the turn still running on it has finished.
 */

import { AgentBridge } from '@ethosagent/agent-bridge';
import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { describe, expect, it, vi } from 'vitest';
import { switchLoop } from '../loop-switch';

function gatedLoop(gate: Promise<void>, log: string[], name: string): AgentLoop {
  return {
    async *run(input: string): AsyncGenerator<AgentEvent> {
      log.push(`${name}:${input}`);
      await gate;
      yield { type: 'done', text: 'ok', turnCount: 1 };
    },
  } as unknown as AgentLoop;
}

describe('switchLoop (F06)', () => {
  it('retires the previous runtime only after the turn running on it finished', async () => {
    const log: string[] = [];
    let finishOldTurn: (() => void) | undefined;
    const oldGate = new Promise<void>((r) => {
      finishOldTurn = r;
    });
    const bridge = new AgentBridge(gatedLoop(oldGate, log, 'old'));
    const inFlight = bridge.send('long task', { sessionKey: 's' });
    await vi.waitFor(() => expect(bridge.isRunning).toBe(true));

    const retirePrevious = vi.fn(async () => {});
    const switched = switchLoop(bridge, {
      loop: gatedLoop(Promise.resolve(), log, 'new'),
      retirePrevious,
    });

    // The swap is immediate; the old runtime is still serving its turn.
    await new Promise((r) => setTimeout(r, 20));
    expect(retirePrevious).not.toHaveBeenCalled();

    finishOldTurn?.();
    await inFlight;
    await switched;
    expect(retirePrevious).toHaveBeenCalledTimes(1);

    // The next turn runs on the new loop.
    await bridge.send('next', { sessionKey: 's' });
    expect(log).toEqual(['old:long task', 'new:next']);
  });

  it('retires at once when no turn is running', async () => {
    const bridge = new AgentBridge(gatedLoop(Promise.resolve(), [], 'old'));
    const retirePrevious = vi.fn(async () => {});
    await switchLoop(bridge, { loop: gatedLoop(Promise.resolve(), [], 'new'), retirePrevious });
    expect(retirePrevious).toHaveBeenCalledTimes(1);
  });
});
