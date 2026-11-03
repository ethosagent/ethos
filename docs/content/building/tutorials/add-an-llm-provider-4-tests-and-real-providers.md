---
title: "Add an LLM provider, part 4: write tests, map a real provider"
description: "Write the provider tests and read the notes on mapping a real provider."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 9-10 of [Add an LLM provider](add-an-llm-provider.md): Write tests; Notes on mapping a real provider.

## Prereqs

- Complete [part 3 of 4](add-an-llm-provider-3-wire-and-run.md).

## 9. Write tests

Test the provider by consuming the async iterable and asserting on the chunks. Create `extensions/llm-echo/src/__tests__/echo.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { CompletionChunk, Message } from '@ethosagent/types';
import { EchoProvider } from '..';

async function collect(stream: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const userMessages: Message[] = [{ role: 'user', content: 'hi' }];

describe('EchoProvider', () => {
  it('streams text_delta then usage then done.end_turn', async () => {
    const p = new EchoProvider({ charsPerChunk: 100 });
    const chunks = await collect(p.complete(userMessages, [], {}));
    expect(chunks).toEqual([
      { type: 'text_delta', text: 'You said: hi' },
      {
        type: 'usage',
        usage: {
          inputTokens: 2,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0,
        },
      },
      { type: 'done', finishReason: 'end_turn' },
    ]);
  });

  it('emits tool_use_* sequence when configured', async () => {
    const p = new EchoProvider({ emitToolCallOnTurn: 1, charsPerChunk: 100 });
    const tools = [{ name: 'get_weather', description: '', parameters: {} }];
    const chunks = await collect(p.complete(userMessages, tools, {}));

    const starts = chunks.filter((c) => c.type === 'tool_use_start');
    const ends = chunks.filter((c) => c.type === 'tool_use_end');
    const done = chunks.find((c) => c.type === 'done');

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(done).toEqual({ type: 'done', finishReason: 'tool_use' });
    expect((ends[0] as { inputJson: string }).inputJson).toEqual('{"city":"Tokyo"}');
  });

  it('honours abortSignal between text chunks', async () => {
    const controller = new AbortController();
    const p = new EchoProvider({ charsPerChunk: 2, delayMs: 20 });
    const iter = p.complete(userMessages, [], { abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const chunks: CompletionChunk[] = [];
    try {
      for await (const c of iter) chunks.push(c);
    } catch {
      // aborted from inside sleep — fine.
    }
    // Should have stopped well before the full text completed.
    const textChars = chunks
      .filter((c) => c.type === 'text_delta')
      .map((c) => (c as { text: string }).text)
      .join('').length;
    expect(textChars).toBeLessThan(10);
  });
});
```

Run them:

```bash
pnpm --filter @ethosagent/llm-echo test
```

All three pass. The interesting one is the third — verifying that abort propagates without leaving the iterator hanging. Every production provider needs the same test.

## 10. Notes on mapping a real provider

The echo provider is artificial; a real provider walks the same five questions:

- **How does the upstream signal a text delta?** Anthropic emits `content_block_delta` with `type: 'text_delta'`; OpenAI emits `delta.content`. Map both to `{ type: 'text_delta', text }`.
- **How does the upstream stream tool calls?** OpenAI streams index-keyed deltas — the first delta has `id` and `name`, subsequent deltas only have `arguments`. Build a `Map<number, { id, name, args }>` keyed by index, not by id (which arrives late and may be empty). Anthropic uses `content_block_start` with a `tool_use` block. The pattern is in `extensions/llm-anthropic/src/index.ts` and `extensions/llm-openai-compat/src/index.ts` — both are under 350 lines and worth reading end to end.
- **When does the upstream report token usage?** Anthropic's `message_start` event carries the prompt token count; the final `message_delta` event carries the output count. OpenAI sends a single `usage` chunk at the end when `stream_options.include_usage` is set. Always emit `usage` before `done`.
- **How does the upstream signal turn completion?** OpenAI's `choice.finish_reason` is `stop` or `tool_calls`; Anthropic's `message_delta.stop_reason` is `end_turn` or `tool_use`. Map both to the four `done.finishReason` literals.
- **How do you classify errors for failover?** The `FailoverReason` enum in `packages/types/src/llm.ts` is what `ChainedProvider` uses to decide between retry, fall through to the next provider, or give up. Look at `classifyError` in `extensions/llm-anthropic/src/index.ts` for the mapping pattern.

The five questions are the work. Once you can answer them for your upstream, the rest of the file is mechanical.

## What you learned

- `LLMProvider` is implemented as an `async function*` that yields `CompletionChunk` variants until the turn is done.
- Order matters: `text_delta` / `thinking_delta` / `tool_use_*` chunks first, then exactly one `usage`, then exactly one `done` with a `finishReason`. The AgentLoop branches on `done.finishReason` to decide whether to run tools or end the turn.
- `tool_use_delta` is presentation only — the AgentLoop parses `inputJson` from the `tool_use_end` event.
- `options.abortSignal` must propagate to every `await` in `complete()`; surfaces close cleanly only when the provider honours cancellation.
- Provider selection lives in `createSingleProvider` in `packages/wiring/src/index.ts` — one string match, one constructor call. The same factory is reused inside the `ChainedProvider` failover chain.
- Path aliases in the root `tsconfig.json` let the rest of the workspace import the provider against source. No build step needed in dev.
- `countTokens` is best-effort; a coarse `chars / 4` is acceptable when the upstream offers no count endpoint.

## Next step

You have a provider whose chunks drive the same loop as Anthropic and OpenAI. The other extension surface — the channel adapter — connects an external messaging platform to the same `AgentEvent` stream.

- [Add a channel adapter](./add-a-channel-adapter.md) — bridge stdin/stdout, Slack, or anything else into the gateway.
- [Write your first tool](./write-your-first-tool.md) — the matching tutorial for the tool surface.
- [LLM provider interface reference](../reference/llm-provider-interface.md) — every field on `LLMProvider`, `CompletionChunk`, `TokenUsage`, and `FailoverReason`.
- [AgentEvent reference](../reference/agent-event.md) — the eight-variant stream the AgentLoop emits to surfaces.
