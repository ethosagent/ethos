---
title: "Write an LLM provider plugin"
description: "Ship a plugin that registers a custom LLM provider via registerLLMProvider so any personality can route inference through it."
kind: how-to
audience: developer
slug: write-an-llm-provider-plugin
time: "20 min"
updated: 2026-05-14
---

## Task

Create a plugin that registers a custom [LLM provider](../../getting-started/glossary.md#llm-provider) into the provider registry. Once installed, any personality can route inference through your provider by setting `provider: <your-plugin-id>/<name>` in `~/.ethos/config.yaml`.

## Result

The agent resolves your provider from the registry at startup. Chained failover, auxiliary models (compression summarizer, vision), and per-personality model routing all participate through the same registry lookup. Your provider receives secrets via `SecretsResolver` and never touches plaintext API keys directly.

## Prereqs

- TypeScript familiarity, Node 24+, pnpm on `PATH`.
- A working inference endpoint (self-hosted vLLM, Bedrock proxy, Cohere API, etc.).
- Understanding of the `CompletionChunk` streaming union (7 variants in `packages/types/src/llm.ts`).

## Steps

### 1. Scaffold the plugin

Create a standard Ethos plugin package with `ethos.type: "plugin"` and `ethos.pluginContractMajor: 2` in `package.json`.

```json title="package.json"
{
  "name": "ethos-plugin-cohere",
  "version": "1.0.0",
  "description": "Cohere Command R+ provider for Ethos",
  "main": "src/index.ts",
  "ethos": {
    "type": "plugin",
    "pluginContractMajor": 2
  },
  "dependencies": {
    "@ethosagent/types": "workspace:*"
  }
}
```

### 2. Implement LLMProvider

Your provider must implement `LLMProvider` from `@ethosagent/types`. The `complete()` method returns `AsyncIterable<CompletionChunk>`. Map your SDK's streaming events to the 7-variant union.

```ts title="src/cohere-provider.ts"
import type { CompletionChunk, CompletionOptions, LLMProvider, Message, Tool } from '@ethosagent/types';

export class CohereProvider implements LLMProvider {
  readonly model: string;
  readonly supportsCaching = false;
  readonly supportsThinking = false;
  readonly maxContextTokens = 128_000;

  constructor(private readonly apiKey: string, model: string) {
    this.model = model;
  }

  async *complete(
    messages: Message[],
    tools: Tool[],
    options?: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const response = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      }),
      signal: options?.abortSignal,
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));
        if (data.type === 'content-delta') {
          yield { type: 'text_delta', text: data.delta?.message?.content?.text ?? '' };
        }
      }
    }

    yield {
      type: 'usage',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
      },
    };
    yield { type: 'done', finishReason: 'end_turn' };
  }
}
```

### 3. Register via the plugin activate function

The plugin's `activate(api)` function calls `api.registerLLMProvider(name, factory)`. The factory receives `LLMProviderFactoryContext` with `config`, `secrets`, and `logger`. Resolve API keys through `secrets.get()`.

```ts title="src/index.ts"
import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import { CohereProvider } from './cohere-provider';

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('command-r', async ({ config, secrets, logger }) => {
    const apiKey = await secrets.get('providers/cohere/apiKey');
    if (!apiKey) {
      throw new Error('Cohere API key not found in secrets store');
    }
    const model = (config.model as string) ?? 'command-r-plus';
    logger.info(`Cohere provider activated: model=${model}`);
    return new CohereProvider(apiKey, model);
  });
}
```

The registered name becomes `ethos-plugin-cohere/command-r` (plugin id prefix is added automatically for unqualified names).

### 4. Configure in config.yaml

Point the agent at your provider:

```yaml title="~/.ethos/config.yaml"
provider: ethos-plugin-cohere/command-r
model: command-r-plus
```

Store the API key in secrets:

```bash
ethos secrets set providers/cohere/apiKey <your-key>
```

### 5. Declare capabilities honestly

The agent loop reads `supportsCaching`, `supportsThinking`, and `maxContextTokens` to decide prompt structure and budget caps. Declaring `supportsCaching: true` when your backend does not cache corrupts cost accounting. Declare only what your endpoint actually supports.

## Verify

```bash
ethos chat -q "hello, which model are you?"
```

The response should come from your Cohere endpoint. Check the usage event in verbose mode:

```bash
ethos chat --verbose -q "what is 2+2?"
```

## Troubleshoot

**"LLM provider X is not registered"** — The plugin did not load. Check `ethos plugins list` and verify `ethos.pluginContractMajor: 2` in your package.json.

**"missing required capability declarations"** — Your `LLMProvider` implementation is missing `supportsCaching`, `supportsThinking`, or `maxContextTokens`. These are required readonly fields.

**Factory never called** — The `provider` value in config.yaml must match the registered name exactly (including the plugin id prefix). Use `ethos-plugin-cohere/command-r`, not just `command-r`.

**Secrets return null** — Run `ethos secrets set providers/cohere/apiKey <key>` to store the key. The secrets resolver checks `~/.ethos/secrets/` first, then falls back to environment variables.
