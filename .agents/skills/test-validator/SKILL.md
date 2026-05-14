---
name: test-validator
description: |
  Run the project's test suite and return failures as agent-readable JSON. Use after
  writing or modifying code, before declaring done, or when the user says "run tests",
  "check tests", "did anything break". Wraps `pnpm test --reporter=json` — much faster
  for an agent to parse than scrolling colored console output. Returns
  {passed, failed, duration_ms, failures: [{file, test, line, error}]}.
  NOT a replacement for `pnpm check` (typecheck + lint + test) — use that as the
  full pre-ship gate. This skill is targeted: just the test outcomes.
allowed-tools: Bash(test-validate *), Bash(*/test-validate *), Bash(pnpm test*), Bash(pnpm vitest*)
---

# Test Validator

Runs vitest with the JSON reporter and parses results into a flat agent-readable shape. Avoids the parsing cost of colored console output and gives a single structured object you can act on directly.

## Usage

```bash
.agents/skills/test-validator/scripts/test-validate [test-path-or-pattern]
```

- No argument: runs the full test suite (`pnpm test`)
- With argument: runs only matching tests (`pnpm test <pattern>`)

## Output shape

```json
{
  "passed": 142,
  "failed": 2,
  "duration_ms": 8341,
  "failures": [
    {
      "file": "packages/core/src/__tests__/agent-loop.test.ts",
      "test": "AgentLoop > emits tool_end on rejection",
      "line": 217,
      "error": "expected 'tool_end' but got 'tool_start'"
    }
  ]
}
```

On parser failure (vitest reporter format change, no output, etc.) the script falls back to `{ error, raw_output }` so the agent always gets something actionable.

## When to use

- After writing or modifying any code, before declaring done.
- When the user says "run tests", "check tests", "did anything break".
- Before invoking `/openai-reviewer` — reviews are cleaner when tests pass first.
- Iterating on a single failing file: pass the file path as the argument to scope the run.

## When NOT to use

- For typecheck-only or lint-only checks — call `pnpm typecheck` / `pnpm lint` directly.
- For the full pre-ship gate — use `pnpm check` (typecheck + lint + test together).
- As a synonym for "did this PR break anything" — that's `/openai-reviewer` territory.

## Read-only

Runs the test suite in non-mutating mode. Does not write to the codebase. Safe to call repeatedly.
