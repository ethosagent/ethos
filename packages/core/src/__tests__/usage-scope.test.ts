import type { CompletionChunk, LLMProvider, UsageRecord } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { MeteredProvider } from '../providers/metered-provider';
import { activeUsageScope, withUsageScope } from '../usage-scope';

// plan background-usage-accounting §5.2 — the usage scope lends attribution to
// metered calls made inside it, and `charge`s a turn_utility call's cost to
// the scope's opener while the scope is open (the run-taint rule: work that
// outlives the scope inherits the attribution but can change nothing).

function costedProvider(cost: number): LLMProvider {
  return {
    name: 'p',
    model: 'm',
    maxContextTokens: 1000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'x' };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: cost,
        },
      };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function drain(p: LLMProvider): Promise<void> {
  for await (const _ of p.complete([{ role: 'user', content: 'q' }], [], {})) {
    // drain
  }
}

function setup(attribution?: { sessionId?: string; personalityId?: string }) {
  const rows: UsageRecord[] = [];
  const provider = new MeteredProvider({
    inner: costedProvider(0.5),
    kind: 'tool_llm',
    recorder: { record: (r) => rows.push(r) },
    ...(attribution ? { attribution } : {}),
  });
  return { rows, provider };
}

describe('usage scope', () => {
  it('there is no active scope outside withUsageScope', () => {
    expect(activeUsageScope()).toBeUndefined();
  });

  it('the scope fills attribution gaps', async () => {
    const { rows, provider } = setup();
    await withUsageScope(
      { attribution: { sessionId: 's1', sessionKey: 'k1', personalityId: 'p1' } },
      () => drain(provider),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 's1', sessionKey: 'k1', personalityId: 'p1' });
  });

  it('static attribution wins over the scope', async () => {
    const { rows, provider } = setup({ personalityId: 'static-p' });
    await withUsageScope({ attribution: { sessionId: 's1', personalityId: 'scope-p' } }, () =>
      drain(provider),
    );
    expect(rows[0]).toMatchObject({ sessionId: 's1', personalityId: 'static-p' });
  });

  it('a nested scope overrides the outer one wholesale', async () => {
    const { rows, provider } = setup();
    await withUsageScope({ attribution: { sessionId: 'outer', personalityId: 'outer-p' } }, () =>
      withUsageScope({ attribution: { sessionId: 'inner' } }, () => drain(provider)),
    );
    expect(rows[0]?.sessionId).toBe('inner');
    // Not merged: an inner scope (a per-job scope, D10) must not borrow the
    // outer job's fields.
    expect(rows[0]?.personalityId).toBeUndefined();
  });

  it('charges a turn_utility call to the open scope exactly once', async () => {
    const { provider } = setup();
    const charges: number[] = [];
    await withUsageScope({ attribution: {}, charge: (usd) => charges.push(usd) }, () =>
      drain(provider),
    );
    expect(charges).toEqual([0.5]);
  });

  it('work that outlives the scope keeps the attribution but is not charged', async () => {
    const { rows, provider } = setup();
    const charges: number[] = [];
    let late: Promise<void> | undefined;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await withUsageScope(
      { attribution: { sessionId: 'opener' }, charge: (usd) => charges.push(usd) },
      async () => {
        // Kicked off inside the scope, runs after it settled (an executor loop, a timer).
        late = gate.then(() => drain(provider));
      },
    );
    expect(activeUsageScope()).toBeUndefined();
    release();
    await late;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('opener');
    expect(charges).toEqual([]);
  });

  it('closes the scope when the work throws', async () => {
    let seen: ReturnType<typeof activeUsageScope>;
    await expect(
      withUsageScope({ attribution: { sessionId: 's' } }, async () => {
        seen = activeUsageScope();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen?.open).toBe(false);
  });
});
