# Custom Context Engine Template

A starter template for building custom context engines in the Ethos agent
framework. Context engines control how conversation history is compacted when
it approaches the model's token budget.

## Quick start

1. Copy the `templates/context-engine/` directory into your workspace.
2. Rename the package in `package.json` (replace `YOURNAME`).
3. Rename `CustomContextEngine` and set the `name` property to your engine's
   unique identifier.
4. Implement your compaction strategy in the `compact()` method.
5. Install dependencies: `pnpm install`.
6. Run the tests: `pnpm vitest run`.

## The ContextEngine interface

Every context engine implements three members from `@ethosagent/types`:

### `name: string` (required)

A unique identifier for your engine. This is the string personality authors
reference in their config: `context_engine: my_engine_name`.

### `compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput>` (required)

Called when the framework decides compaction is needed. Receives the full
message history, system prompt, target token budget, and optional helper
handles. Must return a shorter (or equal-length) message history that fits
within the budget.

The output object supports optional fields for audit and caching:

- `messages` -- the compacted message array (required).
- `notes` -- a human-readable string describing what happened (required).
- `summaryText` -- the generated summary, if any.
- `removed` -- an array of `{ index, reason }` entries for evicted messages.
- `summaries` -- an array of `{ text, sourceRange }` for generated summaries.
- `externalWrites` -- keys written to the external store.
- `cacheBreakpoints` -- message indices where the provider should place cache
  breakpoints.

### `shouldCompact(input: ContextEngineCompactInput): boolean` (optional)

Called before the framework's default 80%-pressure gate. Return `true` to
trigger compaction earlier. The framework's gate is the floor -- you can
trigger sooner, never later.

## Available handles in `ContextEngineCompactInput`

The `opts` argument to `compact()` provides several optional helper handles:

- `opts.llm.summarize(messages, targetTokens)` -- ask the LLM to summarize a
  slice of the conversation.
- `opts.store.write(key, value)` / `opts.store.read(key)` -- page data out to
  an external store for later recall.
- `opts.countTokens(text)` -- model-accurate token count (when available; fall
  back to the `estimateTokens` heuristic otherwise).
- `opts.embed(texts)` -- generate embeddings for semantic similarity.
- `opts.score(a, b)` -- score relevance between two text spans.

All handles are optional. Check for their presence before calling.

## Registering your engine

In your plugin's `setup()` function:

```ts
import { MyEngine } from './my-engine';

export const myPlugin = {
  name: 'my-plugin',
  setup(api) {
    api.registerContextEngine(new MyEngine());
  },
};
```

## Selecting in a personality

In the personality's `config.yaml`:

```yaml
context_engine: my_engine_name
```

The `context_engine` value must match the `name` property of your engine class.

## Testing with the conformance harness

The framework provides `validateContextEngine` from `@ethosagent/core`. It
exercises your engine against several scenarios and validates the output shape:

- **Under-budget** -- 2 short messages with a high token target.
- **Over-budget** -- 20 large messages with a low token target.
- **With handles** -- mock LLM, store, and countTokens injected.
- **shouldCompact** -- if implemented, must return a boolean.
- **Output shape** -- messages array, notes string, valid roles, non-empty
  content, cacheBreakpoints in range, removed entries valid, summaries valid,
  externalWrites valid.

Use it in your tests:

```ts
import { validateContextEngine } from '@ethosagent/core';
import { MyEngine } from './my-engine';

const result = await validateContextEngine(new MyEngine());
expect(result.passed).toBe(true);
```

See `src/index.test.ts` in this template for a complete working example.
