# @ethosagent/tools-decision

## Purpose

The `decide` tool. The agent sends a state and typed questions to the build's decision model and gets typed answers with probabilities. This package holds the input schema and caps, description, result formatting and error mapping; the provider call is injected as a `DecideFn` by wiring (`packages/wiring/src/decision-tool.ts`).

## Public surface

Exported from `src/index.ts` (single entry, no subpaths).

| Export | Kind | One line |
|---|---|---|
| `createDecideTool` | function | Builds `decide` around an injected `DecideFn`. |
| `CreateDecideToolOptions` | interface | Factory options. |
| `DecideFn` | type | The function wiring injects. |
| `DecideCall` | interface | Arguments passed to the `DecideFn`. |
| `DecideOutcome` | type | Success or typed error from the `DecideFn`. |
| `DECIDE_MAX_QUESTIONS` | const | Question cap per call (8). |
| `DECIDE_MAX_STATE_CHARS` | const | State size cap (24,000 chars). |

## Seam

Implements `Tool` from `@ethosagent/types`; request and answer shapes (`DecisionRequest`, `DecisionAnswer`, `DecisionQuestion`) also come from `@ethosagent/types`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-decision
```

Pinning test: `src/__tests__/decide-tool.test.ts` holds the tool shape, boolean, choice and score answer formatting, and that an over-cap question count returns `input_invalid` without calling `decide`.
