# @ethosagent/safety-watcher

## Purpose

A rule-driven watcher over the agent event stream. The host forwards events from `AgentLoop.run()` into `Watcher.observe`, and the first non-allow decision from the rule list is returned. Built-in rules cover call rate, token budget, compounding errors and exfil-shaped tool sequences.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `Watcher` | class | Dispatches events over the rule list. |
| `WatcherOptions` | type | Options for `Watcher`. |
| `WatcherObservability` | type | Optional adapter that records non-allow decisions. |
| `defaultRules` | function | The default rule list. |
| `rateLimitRule` | function | Fires when calls exceed a threshold in a window. |
| `tokenBudgetRule` | function | Fires when a token budget is exceeded. |
| `compoundingErrorRule` | function | Fires on repeated errors. |
| `suspiciousSequenceRule` | function | Fires on suspicious tool sequences. |
| `isExfilShapedTool` | function | Whether a tool name looks like an exfil tool. |
| `EXFIL_TOOL_NAMES` | const | The exfil-shaped tool names. |
| `makeInitialState` | function | Fresh watcher state. |
| `WatcherRule` | type | A rule. |
| `WatcherDecision` | type | A rule decision. |
| `WatcherEvent` | type | An observed event. |
| `WatcherState` | type | Watcher state. |
| `RateLimitOptions` | type | Options for `rateLimitRule`. |
| `TokenBudgetOptions` | type | Options for `tokenBudgetRule`. |
| `CompoundingErrorOptions` | type | Options for `compoundingErrorRule`. |
| `SequenceRuleOptions` | type | Options for `suspiciousSequenceRule`. |

## Seam

Security-kernel layer (`kernel-reads-contracts` in `architecture.config.ts`); depends on `@ethosagent/types` only. The host owns the consumer side; this package does not hook the loop itself. Behaviour is pinned by the tests below.

## Testing

```
pnpm vitest run packages/safety/watcher
```

- `src/__tests__/watcher.test.ts`: allow when no rule fires, first non-allow decision returned, decisions recorded via the adapter.
- `src/__tests__/rules.test.ts`: each rule's threshold and window behaviour.
