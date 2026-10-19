import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  UsageMeterEvent,
  UsageRecord,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  BackgroundBudgetSkipped,
  isMeteredProvider,
  MeteredProvider,
} from '../providers/metered-provider';

// plan background-usage-accounting §5.2 / §10 — the one decorator that writes a
// ledger row per non-turn LLM call. Byte-identical passthrough, one row per
// stream, fail-open recorder, and the background gate.

function usage(cost: number, input = 10, output = 5): CompletionChunk {
  return {
    type: 'usage',
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
      estimatedCostUsd: cost,
    },
    costBasis: 'priced',
  };
}

function scripted(
  chunks: CompletionChunk[],
  opts: { throwAfter?: Error; calls?: CompletionOptions[] } = {},
): LLMProvider {
  return {
    name: 'scripted',
    model: 'base-model',
    maxContextTokens: 1234,
    supportsCaching: true,
    supportsThinking: false,
    supportsVision: { images: true, documents: false },
    capabilities: { streaming: true, toolCalling: true },
    async *complete(_m, _t, options): AsyncIterable<CompletionChunk> {
      opts.calls?.push(options);
      for (const c of chunks) yield c;
      if (opts.throwAfter) throw opts.throwAfter;
    },
    async countTokens() {
      return 42;
    },
  };
}

async function collect(
  p: LLMProvider,
  options: CompletionOptions = {},
): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const c of p.complete([{ role: 'user', content: 'hi' }], [], options)) out.push(c);
  return out;
}

function meter(
  inner: LLMProvider,
  extra: Partial<ConstructorParameters<typeof MeteredProvider>[0]> = {},
) {
  const rows: UsageRecord[] = [];
  const events: UsageMeterEvent[] = [];
  const provider = new MeteredProvider({
    inner,
    kind: 'tool_llm',
    recorder: { record: (r) => rows.push(r) },
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { provider, rows, events };
}

describe('MeteredProvider', () => {
  it('passes every chunk through unchanged (same objects, same order)', async () => {
    const chunks: CompletionChunk[] = [
      { type: 'text_delta', text: 'a' },
      { type: 'thinking_delta', thinking: 't' },
      usage(0.1),
      { type: 'warning', message: 'w' },
      { type: 'done', finishReason: 'end_turn' },
    ];
    const { provider } = meter(scripted(chunks));
    const out = await collect(provider);
    expect(out).toHaveLength(chunks.length);
    for (const [i, c] of out.entries()) expect(c).toBe(chunks[i]);
  });

  it('forwards the provider surface to inner', async () => {
    const inner = scripted([]);
    const { provider } = meter(inner);
    expect(provider.name).toBe('scripted');
    expect(provider.model).toBe('base-model');
    expect(provider.maxContextTokens).toBe(1234);
    expect(provider.supportsCaching).toBe(true);
    expect(provider.supportsThinking).toBe(false);
    expect(provider.supportsVision).toEqual({ images: true, documents: false });
    expect(provider.capabilities).toEqual({ streaming: true, toolCalling: true });
    expect(await provider.countTokens([])).toBe(42);
    expect(isMeteredProvider(provider)).toBe(true);
    expect(isMeteredProvider(inner)).toBe(false);
    expect(provider.kind).toBe('tool_llm');
  });

  it('writes one row per stream with summed tokens and cost', async () => {
    const { provider, rows } = meter(
      scripted([usage(0.1, 10, 5), { type: 'text_delta', text: 'x' }, usage(0.2, 1, 1)]),
      { attribution: { personalityId: 'p', sourceRef: 'web_extract' } },
    );
    await collect(provider);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      kind: 'tool_llm',
      sourceClass: 'turn_utility',
      provider: 'scripted',
      model: 'base-model',
      inputTokens: 11,
      outputTokens: 6,
      cacheReadTokens: 4,
      cacheCreationTokens: 2,
      costBasis: 'priced',
      outcome: 'ok',
      personalityId: 'p',
      sourceRef: 'web_extract',
    });
    expect(row?.estimatedCostUsd).toBeCloseTo(0.3, 12);
    expect(Number.isNaN(Date.parse(row?.ts ?? ''))).toBe(false);
  });

  it('records modelOverride when the call sets one', async () => {
    const { provider, rows } = meter(scripted([usage(0.1)]));
    await collect(provider, { modelOverride: 'cheap-model' });
    expect(rows[0]?.model).toBe('cheap-model');
  });

  it('a stream that throws after a usage chunk records outcome error with the partial usage, and rethrows', async () => {
    const { provider, rows } = meter(scripted([usage(0.4)], { throwAfter: new Error('boom') }));
    await expect(collect(provider)).rejects.toThrow('boom');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('error');
    expect(rows[0]?.estimatedCostUsd).toBe(0.4);
  });

  it('a stream abandoned by its consumer after a usage chunk records outcome aborted', async () => {
    const { provider, rows } = meter(scripted([usage(0.4), { type: 'text_delta', text: 'x' }]));
    for await (const c of provider.complete([], [], {})) {
      if (c.type === 'usage') break;
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('aborted');
  });

  it('a stream with no usage chunk records nothing', async () => {
    const { provider, rows } = meter(scripted([{ type: 'text_delta', text: 'x' }]));
    await collect(provider);
    expect(rows).toEqual([]);
  });

  it('a recorder that throws does not break the stream and fires ledger_write_failed', async () => {
    const chunks: CompletionChunk[] = [usage(0.1), { type: 'done', finishReason: 'end_turn' }];
    const events: UsageMeterEvent[] = [];
    const provider = new MeteredProvider({
      inner: scripted(chunks),
      kind: 'memory_capture',
      recorder: {
        record: () => {
          throw new Error('disk full');
        },
      },
      onEvent: (e) => events.push(e),
    });
    const out = await collect(provider);
    expect(out).toEqual(chunks);
    expect(events).toEqual([
      { type: 'usage.ledger_write_failed', kind: 'memory_capture', error: 'disk full' },
    ]);
  });

  it('gate skip on a background kind throws BackgroundBudgetSkipped without calling inner', async () => {
    const calls: CompletionOptions[] = [];
    const { provider, rows, events } = meter(scripted([usage(0.1)], { calls }), {
      kind: 'memory_capture',
      attribution: { botKey: 'b1', personalityId: 'p1' },
      gate: () => ({ decision: 'skip', spentUsd: 5, capUsd: 5 }),
    });
    const err = await collect(provider).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackgroundBudgetSkipped);
    expect((err as BackgroundBudgetSkipped).code).toBe('background_budget');
    expect(calls).toEqual([]);
    expect(rows).toEqual([]);
    expect(events).toEqual([
      {
        type: 'usage.background_skipped',
        kind: 'memory_capture',
        attribution: { botKey: 'b1', personalityId: 'p1' },
        spentUsd: 5,
        capUsd: 5,
      },
    ]);
  });

  it('gate allow on a background kind lets the call through', async () => {
    const { provider, rows } = meter(scripted([usage(0.1)]), {
      kind: 'memory_capture',
      gate: async () => ({ decision: 'allow' }),
    });
    await collect(provider);
    expect(rows).toHaveLength(1);
  });

  it('a gate that throws fails open', async () => {
    const { provider, rows } = meter(scripted([usage(0.1)]), {
      kind: 'memory_capture',
      gate: () => {
        throw new Error('unreadable');
      },
    });
    await collect(provider);
    expect(rows).toHaveLength(1);
  });

  it('the gate is never asked for a GATE_EXEMPT_KINDS kind (goal_judge, D38)', async () => {
    let asked = 0;
    const { provider, rows } = meter(scripted([usage(0.1)]), {
      kind: 'goal_judge',
      gate: () => {
        asked++;
        return { decision: 'skip' };
      },
    });
    await collect(provider);
    expect(asked).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it('the gate is ignored for a turn_utility kind', async () => {
    let asked = 0;
    const { provider, rows } = meter(scripted([usage(0.1)]), {
      kind: 'compaction',
      gate: () => {
        asked++;
        return { decision: 'skip' };
      },
    });
    await collect(provider);
    expect(asked).toBe(0);
    expect(rows).toHaveLength(1);
  });
});
