---
title: "Add an LLM provider, part 2: implement the provider"
description: "Implement the LLM provider class against the contract."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish step 3 of [Add an LLM provider](add-an-llm-provider.md): Implement the provider.

## Prereqs

- Complete [part 1 of 4](add-an-llm-provider.md).

## 3. Implement the provider

Open `extensions/llm-echo/src/index.ts` and write the body. The implementation has three parts: type the constructor inputs, define the `complete` generator that yields `CompletionChunk` events, and stub `countTokens`.

```typescript
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';

export interface EchoProviderConfig {
  /** Latency between text chunks in ms. Lets you watch the stream render. */
  charsPerChunk?: number;
  delayMs?: number;
  /** When true, the second turn pretends the model called a tool. Lets the
   *  tutorial exercise the tool_use_* variants without a real model. */
  emitToolCallOnTurn?: number;
}

export class EchoProvider implements LLMProvider {
  readonly name = 'echo';
  readonly model = 'echo-v0';
  readonly maxContextTokens = 100_000;
  readonly supportsCaching = false;
  readonly supportsThinking = false;

  constructor(private readonly config: EchoProviderConfig = {}) {}

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    // Extract the last user message — that's what we echo.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userText = this.extractText(lastUser);

    // Branch: should this turn emit a tool_use instead of a text reply?
    // The loop sees `done.finishReason: 'tool_use'` and runs the named tool.
    const wantsTool =
      tools.length > 0 &&
      this.config.emitToolCallOnTurn !== undefined &&
      messages.length === this.config.emitToolCallOnTurn;

    if (wantsTool) {
      const tool = tools[0];
      yield* this.emitToolCall(tool.name, options);
      yield this.makeUsage(userText.length, 16);
      yield { type: 'done', finishReason: 'tool_use' };
      return;
    }

    // Default: stream the user's message back as the assistant text.
    yield* this.emitText(`You said: ${userText}`, options);
    yield this.makeUsage(userText.length, userText.length + 8);
    yield { type: 'done', finishReason: 'end_turn' };
  }

  async countTokens(messages: Message[]): Promise<number> {
    // No upstream — approximate at chars / 4 like the openai-compat provider.
    const chars = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + content.length;
    }, 0);
    return Math.ceil(chars / 4);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private extractText(msg: Message | undefined): string {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    return msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }

  private async *emitText(
    text: string,
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const stride = this.config.charsPerChunk ?? 8;
    const delay = this.config.delayMs ?? 0;

    for (let i = 0; i < text.length; i += stride) {
      // Respect cancellation — the loop wires /stop and timeouts through here.
      if (options.abortSignal?.aborted) return;
      if (delay > 0) await sleep(delay, options.abortSignal);
      yield { type: 'text_delta', text: text.slice(i, i + stride) };
    }
  }

  private async *emitToolCall(
    toolName: string,
    _options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const callId = `echo-${Date.now()}`;
    yield { type: 'tool_use_start', toolCallId: callId, toolName };
    // Stream the input JSON as deltas — surfaces that render in-flight
    // arguments will show the JSON growing. The end event carries the full
    // parsed shape; deltas are presentation, not contract.
    yield { type: 'tool_use_delta', toolCallId: callId, partialJson: '{"city":' };
    yield { type: 'tool_use_delta', toolCallId: callId, partialJson: '"Tokyo"}' };
    yield {
      type: 'tool_use_end',
      toolCallId: callId,
      inputJson: '{"city":"Tokyo"}',
    };
  }

  private makeUsage(inputTokens: number, outputTokens: number): CompletionChunk {
    return {
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
      },
    };
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}
```

That is the whole provider. Walk through the interesting parts:

- **`complete` is `async function*`.** The body looks linear — `yield`, `await`, `yield` — but the consumer pulls one chunk at a time. The loop never buffers your output; backpressure is automatic.
- **The branch on `emitToolCallOnTurn`** exists only so this tutorial can exercise the `tool_use_*` variants. A real provider does not own the decision — the model does — but the echo provider lets you wire the test deterministically.
- **`emitText` checks `options.abortSignal` between chunks.** A long completion that ignores the signal keeps streaming after the surface has moved on. Most production providers wire the signal into their HTTP client (`fetch(..., { signal })`) — the check here is for the local sleep, not the network.
- **`tool_use_delta` is presentation, not contract.** The loop parses `inputJson` from the `tool_use_end` event. Surfaces that show in-flight argument streaming use the deltas; tests that consume the iterable for assertions can ignore them.
- **`countTokens` returns a coarse approximation.** Better numbers improve compaction precision; bad numbers degrade it but never break the turn. Anthropic users get exact counts via the SDK; OpenAI-compat users get `chars / 4`.

## What you learned

- Step 3 done: Implement the provider.

## Next step

Continue with [part 3 of 4: wire, run and exercise tool calls](add-an-llm-provider-3-wire-and-run.md).
