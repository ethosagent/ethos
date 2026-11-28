# @ethosagent/tools-tier

## Purpose

The `think_deeper` tool, which the model calls to ask for the deep model tier on the next call. The tool itself only returns an acknowledgement string that includes the reason.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths).

| Export | Kind | One line |
|---|---|---|
| `createThinkDeeperTool` | function | Builds `think_deeper`. |

## Seam

Implements `Tool` from `@ethosagent/types`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`. This package only asks. Core performs the switch. `packages/core/src/agent-loop/stages/tool-processing.ts` (`tierEscalationRef`, the `think_deeper` branch) sets a one-shot flag on success, and `streamStep` (`packages/core/src/agent-loop/stages/stream-step.ts`) re-resolves the next call to the `deep` role through `resolveTurnModel`, then drops back. If `deep` does not resolve, the turn's model is kept. Pinned by `packages/core/src/__tests__/model-tier.test.ts`, `describe('think_deeper escalation')` and `describe('think_deeper round trip')`.

## Testing

```
pnpm vitest run extensions/tools-tier
```

Pinning test: `src/__tests__/think-deeper.test.ts` holds the success value containing the reason and the tool metadata.

Switch pinning test: `packages/core/src/__tests__/model-tier.test.ts` (`think_deeper escalation`, `think_deeper round trip`) holds the fast, deep, fast round trip.

Limits: core caps escalations at 2 per turn and 10 per session (`packages/core/src/agent-loop/tier-escalation.ts`). The session count includes successful `think_deeper` calls even when `deep` did not resolve, and `/budget reset` also resets it. Round trip with the real tool: `src/__tests__/round-trip.test.ts`.
