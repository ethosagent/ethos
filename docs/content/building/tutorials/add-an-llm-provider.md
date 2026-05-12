---
title: "Add an LLM provider"
description: "Build an echo provider implementing LLMProvider — map a streaming source to the seven-variant CompletionChunk union, ship as extensions/llm-echo."
kind: tutorial
audience: developer
slug: add-an-llm-provider
time: "30 min"
updated: 2026-05-12
---

`LLMProvider` is the seam between Ethos and any model API. The [AgentLoop](../../getting-started/glossary.md#agent-loop) does not know what provider it is talking to — it consumes `AsyncIterable<CompletionChunk>` from `provider.complete()` and yields `AgentEvent` to whatever surface is listening. Your job, as a provider author, is to map your upstream API's streaming events to seven `CompletionChunk` variants.

This tutorial builds an "echo" provider as the smallest possible exercise of every variant. The provider does not talk to a remote API; it echoes the last user message back, character by character, while emitting realistic `text_delta`, `tool_use_*`, `usage`, and `done` chunks. Once it works, swap the echo body for a real client and the rest of the file stays.

You ship it as `extensions/llm-echo/` inside the monorepo, wired via `config.provider: echo` and a one-line addition to `packages/wiring/src/index.ts`.

## Goal

By the end, you have:

- `extensions/llm-echo/` — a workspace package implementing `LLMProvider` from `@ethosagent/types`.
- An async generator that maps a local stream to the seven `CompletionChunk` variants, including a tool-call delta.
- A path alias and a wiring branch so `config.provider: echo` selects your provider.
- Unit tests that consume the async iterable and assert on the chunks emitted.
- `pnpm dev` running with the echo provider — the agent "responds" by echoing the user message back, every event arrives through the same `AgentLoop` pipeline as a real model.

The echo provider is the lab. Once you can map a local stream to `CompletionChunk`, you can map any real provider — the shape of the work does not change.

## Prereqs

- [Build on Ethos in ten minutes](../quickstart.md) finished — the monorepo cloned, `pnpm check` green, `pnpm dev` runs a chat against your tree.
- Familiarity with `async function*` generators and `for await ... of` loops. The contract is pure async iteration; no event emitters, no callbacks.
- A read of `packages/types/src/llm.ts` (90 lines). Every interface in this tutorial is declared there.
- Optional: skim `extensions/llm-anthropic/src/index.ts` and `extensions/llm-openai-compat/src/index.ts`. The two production providers cover the two interesting cases — content-block streaming and index-keyed tool calls.

## 1. Read the contract

`packages/types/src/llm.ts` is the source of truth. The interfaces in order of how often you touch them:

```typescript
export type CompletionChunk =
  | { type: 'text_delta';     text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_start'; toolCallId: string; toolName: string }
  | { type: 'tool_use_delta'; toolCallId: string; partialJson: string }
  | { type: 'tool_use_end';   toolCallId: string; inputJson: string }
  | { type: 'usage';          usage: TokenUsage }
  | { type: 'done';           finishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' };

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching: boolean;
  readonly supportsThinking: boolean;
  complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk>;
  countTokens(messages: Message[]): Promise<number>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
}
```

A few rules implicit in the contract:

- **One `tool_use_start`, then deltas, then exactly one `tool_use_end` per tool call.** The `inputJson` on the end event is the complete arguments JSON — the AgentLoop parses it once, not the running concatenation of deltas. Emit `tool_use_delta` for streaming-UI surfaces; the loop tolerates zero deltas, only `start` + `end` is required.
- **`usage` must come before `done`.** The loop checks for `usage` to populate the `AgentEvent` of the same name and budget-cap accounting. A provider that never emits `usage` ends the [turn](../../getting-started/glossary.md#turn) with zero recorded cost.
- **Always emit exactly one `done`.** It carries the `finishReason`. The loop branches on `'tool_use'` (run the requested tools and loop back) vs `'end_turn'` (the turn is finished). Without `done`, the surface waits forever for the next chunk.
- **Respect `options.abortSignal`.** Upstream cancellation, `/stop`, and turn timeouts all flow through this signal. Pass it into your network client and the loop closes cleanly.
- **`countTokens` is best-effort.** Anthropic publishes a count endpoint; OpenAI does not, and the compat provider approximates `chars / 4`. The loop uses the count for compaction triggering — a bad number degrades compaction quality, it does not break correctness.

The full reference is at [LLM provider interface](../reference/llm-provider-interface.md).

## 2. Create the extension package

Pick a name; the convention is `extensions/llm-<provider>/`. We are building `llm-echo`:

```bash
mkdir -p extensions/llm-echo/src/__tests__
cd extensions/llm-echo
```

Write `package.json`:

```json
{
  "name": "@ethosagent/llm-echo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "production": "./dist/index.js"
    }
  },
  "dependencies": {
    "@ethosagent/types": "workspace:*"
  }
}
```

Two conventions to notice:

- **`exports` points at `./src/index.ts`.** Node 24 + tsx resolves the source directly in dev — no build step. The `production` condition points at `./dist/` for the published artefact (`tsup` builds it for release; you do not need it locally).
- **`@ethosagent/types: workspace:*`.** Provider packages depend on `@ethosagent/types` and nothing else from the framework. The interface contract is the only thing you implement against.

Run install from the repo root so pnpm picks up the new workspace member:

```bash
cd ../../
pnpm install
```

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

## 4. Add the path alias

Open the root `tsconfig.json` (or `tsconfig.base.json` — check `extends` in the root) and add the new package to `compilerOptions.paths`:

```json
{
  "compilerOptions": {
    "paths": {
      "@ethosagent/llm-anthropic": ["./extensions/llm-anthropic/src"],
      "@ethosagent/llm-openai-compat": ["./extensions/llm-openai-compat/src"],
      "@ethosagent/llm-echo": ["./extensions/llm-echo/src"]
    }
  }
}
```

Without this alias, `import { EchoProvider } from '@ethosagent/llm-echo'` resolves to `node_modules` (where the package does not exist) and `pnpm typecheck` fails. With it, every workspace package can import the new provider against source.

## 5. Wire it into the provider factory

Provider selection lives in `packages/wiring/src/index.ts` inside `createSingleProvider`. The current shape:

```typescript
function createSingleProvider(cfg: {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LLMProvider {
  if (cfg.provider === 'anthropic') {
    return new AnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model });
  }
  return new OpenAICompatProvider({
    name: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl ?? 'https://openrouter.ai/api/v1',
  });
}
```

Add an `echo` branch before the OpenAI-compat fallback:

```typescript
import { EchoProvider } from '@ethosagent/llm-echo';

function createSingleProvider(cfg: {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LLMProvider {
  if (cfg.provider === 'anthropic') {
    return new AnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model });
  }
  if (cfg.provider === 'echo') {
    return new EchoProvider();
  }
  return new OpenAICompatProvider({
    name: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl ?? 'https://openrouter.ai/api/v1',
  });
}
```

Two things to notice:

- **The factory ignores `apiKey` and `baseUrl` for echo.** Real providers receive these from `~/.ethos/config.yaml` (`apiKey`) or fall back to a sensible default (`baseUrl`). The factory is the only place those values are dereferenced — your provider's constructor takes whatever shape it needs.
- **You match on `cfg.provider`.** That string is whatever the user wrote under `provider:` in `~/.ethos/config.yaml`. The OpenAI-compat provider uses the same string as the cosmetic `name` for log lines and `/usage` output (`openrouter`, `ollama`, `gemini`); the Anthropic provider hard-codes its own name.

For multi-provider chains (failover), the same factory is called per entry; nothing else changes.

## 6. Switch your config to the echo provider

Open `~/.ethos/config.yaml` and change the provider line:

```yaml
provider: echo
model: echo-v0
apiKey: not-used-for-echo
```

`apiKey` is required by the schema even though the echo provider ignores it — leave any non-empty string here.

## 7. Run it

```bash
pnpm dev
```

The chat opens. Send a message:

```
You > hello there, world.
```

The streamed reply:

```
You said: hello there, world.
```

Every `text_delta` arrived through `AgentLoop` and reached the surface as a `text_delta` `AgentEvent`. The usage chunk landed under `/usage` (run it inside chat) as zero-cost token counts. The `done` event with `finishReason: 'end_turn'` closed the turn cleanly.

Things you should verify:

- `/usage` shows tokens for both input and output. If the counts are zero, the `usage` chunk is not being yielded — check that you yield it before `done`.
- `Ctrl+C` during a slow stream (set `delayMs: 200` in the constructor) cleanly aborts. If the chat hangs, the `abortSignal` is not being honoured — every `await` in `complete` must be cancellable.
- Switching back to `provider: anthropic` works without restarting the dev shell. The provider is constructed per `createAgentLoop` call, not at process start.

## 8. Exercise the tool-call path

The interesting half of the contract — `tool_use_start`, `tool_use_delta`, `tool_use_end` — has not fired yet because the default echo path skips it. Construct the provider with `emitToolCallOnTurn: 2` to force a tool call on the second turn of the session. Edit the wiring branch:

```typescript
if (cfg.provider === 'echo') {
  return new EchoProvider({ emitToolCallOnTurn: 2 });
}
```

Restart `pnpm dev`. First turn produces the echo. On the second turn, send anything:

```
You > make me lunch.
```

The chat surface streams:

```
[tool_start  ] get_weather { city: "Tokyo" }
[tool_end    ] get_weather · ok · 412ms
You said: make me lunch.
```

The provider yielded `tool_use_start` → two `tool_use_delta` chunks → `tool_use_end` with the full `inputJson` → `done.finishReason: 'tool_use'`. The loop:

1. Saw `finishReason: 'tool_use'`.
2. Parsed `inputJson` once into `{ city: "Tokyo" }`.
3. Ran `executeParallel` against the active personality's [tool registry](../../getting-started/glossary.md#tool-registry).
4. Looped back into `provider.complete()` with the tool result appended as a user message.
5. The echo provider's second iteration emitted the text echo.

This is exactly how a real model interleaves text and tool calls. The chunk sequence is identical; only the source of the decisions changes.

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

- `LLMProvider` is implemented as an `async function*` that yields one of seven `CompletionChunk` variants until the turn is done.
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
