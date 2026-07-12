// Transport hop (plan §P8, Phase 7 exposure) — proves `ctx.a2aDelegation` set on
// the AgentLoop's ToolContext reaches a tool through the LocalToolTransport rebuild.
//
// The transport reconstructs the tool ctx from the SERIALIZABLE request plus the
// LIVE side-channel. `a2aDelegation` carries a live `reserveOutbound` callback, so
// it can only ride the side-channel — this test locks in that it does.

import type { Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultToolRegistry } from '../tool-registry';

const echoDelegation: Tool = {
  name: 'echo_delegation',
  description: 'Echoes the ambient A2A delegation frame it can see on ctx.',
  schema: { type: 'object' },
  capabilities: {},
  execute: async (_args, ctx) => {
    const d = ctx.a2aDelegation;
    if (!d) return { ok: true, value: 'no-delegation' };
    return {
      ok: true,
      value: `depth=${d.depth} trace=${d.traceId} reserve=${d.reserveOutbound()}`,
    };
  },
};

const makeCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: 's1',
  sessionKey: 'cli:default',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 10_000,
  ...overrides,
});

describe('ctx.a2aDelegation transport hop', () => {
  it('a tool sees the delegation frame carried on the AgentLoop ctx', async () => {
    const reg = new DefaultToolRegistry();
    reg.register(echoDelegation);

    let reserved = 0;
    const results = await reg.executeParallel(
      [{ toolCallId: 'c1', name: 'echo_delegation', args: {} }],
      makeCtx({
        a2aDelegation: {
          traceId: 't1',
          depth: 2,
          reserveOutbound: () => {
            reserved += 1;
            return true;
          },
        },
      }),
    );

    const r = results[0]?.result;
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.value).toBe('depth=2 trace=t1 reserve=true');
    expect(reserved).toBe(1);
  });

  it('a tool sees no frame when the ctx did not carry one', async () => {
    const reg = new DefaultToolRegistry();
    reg.register(echoDelegation);

    const results = await reg.executeParallel(
      [{ toolCallId: 'c1', name: 'echo_delegation', args: {} }],
      makeCtx(),
    );

    const r = results[0]?.result;
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.value).toBe('no-delegation');
  });
});
