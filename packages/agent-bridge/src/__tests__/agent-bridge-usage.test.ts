import type { AgentLoop } from '@ethosagent/core';
import { describe, expect, it, vi } from 'vitest';
import { AgentBridge } from '../agent-bridge';

async function* makeEventStream(
  events: { type: string; [k: string]: unknown }[],
): AsyncGenerator<unknown> {
  for (const e of events) {
    await Promise.resolve();
    yield e;
  }
}

describe('AgentBridge usage event', () => {
  it('emits usage with the cache counters only when the event carries them', async () => {
    const loop = {
      run: vi.fn(() =>
        makeEventStream([
          {
            type: 'usage',
            inputTokens: 5,
            outputTokens: 1,
            estimatedCostUsd: 0,
            cacheReadTokens: 80_000,
            cacheCreationTokens: 300,
          },
          { type: 'usage', inputTokens: 7, outputTokens: 2, estimatedCostUsd: 0 },
          { type: 'done', text: '', turnCount: 1 },
        ]),
      ),
    } as unknown as AgentLoop;
    const bridge = new AgentBridge(loop);
    const seen: Array<[number, number, number, unknown]> = [];
    bridge.on('usage', (i, o, c, cache) => seen.push([i, o, c, cache]));
    await bridge.send('hi', {});
    expect(seen).toEqual([
      [5, 1, 0, { cacheReadTokens: 80_000, cacheCreationTokens: 300 }],
      [7, 2, 0, {}],
    ]);
  });
});
