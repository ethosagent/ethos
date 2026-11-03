# @ethosagent/tools-answer-engines

## Purpose

`engine_ask` tool that sends one question to a hosted answer engine and returns the answer with citations. Five engines are registered (ChatGPT, Perplexity, Grok, Gemini, Microsoft Foundry); each is one file under `src/engines/`. Calls go through `ctx.scopedFetch` and secrets through `ctx`, so host and key access are declared per engine.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths). Main entry points; engine ids, result types and error classes are also exported.

| Export | Kind | One line |
|---|---|---|
| `createEngineAskTool` | function | Builds the `engine_ask` tool. |
| `engineAskTool` | const | Default instance. |
| `CreateEngineAskToolOptions` | interface | Options for the factory. |
| `EngineAskArgs` | interface | Tool input. |
| `ALL_ENGINES` | const | The engine roster. |
| `secretGrantsOf` | function | The `capabilities.secrets` entries an engine contributes. |
| `chatgptEngine` | const | ChatGPT engine definition. |
| `perplexityEngine` | const | Perplexity engine definition. |
| `grokEngine` | const | Grok engine definition. |
| `geminiEngine` | const | Gemini engine definition. |
| `microsoftEngine` | const | Microsoft Foundry engine definition. |
| `renderText` | function | Plain-text rendering of an `EngineAnswer`. |

## Seam

Implements `Tool` from `@ethosagent/types`; engines implement the package-local `AnswerEngine` type (`src/engines/types.ts`). Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-answer-engines
```

Pinning tests in `src/__tests__/`: `src/__tests__/engine-ask.test.ts` (availability, input validation), and one file per engine holding its request shape. `src/__tests__/grok.test.ts` asserts optional search fields are never sent; `src/__tests__/microsoft.test.ts` asserts token caching and re-mint inside the expiry margin; `src/__tests__/chatgpt.test.ts`, `src/__tests__/gemini.test.ts`, `src/__tests__/perplexity.test.ts` pin request bodies and identity. Recorded fixtures sit in `src/__tests__/fixtures/`.
