import type { AgentEvent, CompletionChunk, OutboundMessage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { collect, drain, makeCtx, makeFakeAdapter, scriptedLLM } from '../index';

async function* gen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe('drain', () => {
  it('consumes the whole iterable and returns nothing', async () => {
    let consumed = 0;
    async function* counting(): AsyncGenerator<number> {
      for (let i = 0; i < 3; i++) {
        consumed++;
        yield i;
      }
    }
    expect(await drain(counting())).toBeUndefined();
    expect(consumed).toBe(3);
  });
});

describe('collect', () => {
  it('returns the items in order', async () => {
    const events: AgentEvent[] = [{ type: 'text_delta', text: 'a' }];
    expect(await collect(gen(events))).toEqual(events);
    expect(await collect(gen([]))).toEqual([]);
  });
});

describe('makeCtx', () => {
  it('fills every required field and lets overrides win', () => {
    const ctx = makeCtx({ sessionId: 'other', workingDir: '/work' });
    expect(ctx.sessionId).toBe('other');
    expect(ctx.workingDir).toBe('/work');
    expect(ctx.sessionKey).toBe('cli:default');
    expect(ctx.resultBudgetChars).toBe(10_000);
    expect(ctx.abortSignal.aborted).toBe(false);
  });
});

describe('scriptedLLM', () => {
  const run = (llm: ReturnType<typeof scriptedLLM>): Promise<CompletionChunk[]> =>
    collect(llm.complete([{ role: 'user', content: 'q' }], [], {}));

  it('plays text and tool-call steps in order, then falls back to "ok"', async () => {
    const llm = scriptedLLM([[{ id: 't1', name: 'probe', input: { a: 1 } }], 'done']);
    expect(await run(llm)).toEqual([
      { type: 'tool_use_start', toolCallId: 't1', toolName: 'probe' },
      { type: 'tool_use_end', toolCallId: 't1', inputJson: '{"a":1}' },
      { type: 'done', finishReason: 'tool_use' },
    ]);
    expect(await run(llm)).toEqual([
      { type: 'text_delta', text: 'done' },
      { type: 'done', finishReason: 'end_turn' },
    ]);
    expect(await run(llm)).toEqual([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', finishReason: 'end_turn' },
    ]);
  });

  it('records each call', async () => {
    const llm = scriptedLLM(['x']);
    await run(llm);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.messages[0]?.content).toBe('q');
  });
});

describe('makeFakeAdapter', () => {
  it('records sent text and reports ok', async () => {
    const adapter = makeFakeAdapter();
    const msg: OutboundMessage = { text: 'hello' };
    expect(await adapter.send('C1', msg)).toEqual({ ok: true, messageId: 'm1' });
    expect(adapter.sentMessages).toEqual(['hello']);
    expect(await adapter.health()).toEqual({ ok: true });
  });

  it('applies overrides', () => {
    const adapter = makeFakeAdapter({ id: 'slack:bot-9', maxMessageLength: 3000 });
    expect(adapter.id).toBe('slack:bot-9');
    expect(adapter.maxMessageLength).toBe(3000);
  });
});
