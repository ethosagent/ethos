---
name: schema-validator
description: |
  Validate code changes against the project's frozen data contracts (packages/types/).
  Catches breaking changes to PersonalityConfig, AgentEvent, ContextEngine, Storage,
  the plugin contract, and the rest of the schema-frozen interfaces — early, before
  the full test suite. Use when touching anything under packages/types/, adding a
  field to a frozen schema, or changing a contract interface. Returns
  {touched_schemas: [...], gate_tests: {passed, failed, details}}. Read-only.
allowed-tools: Bash(schema-validate *), Bash(*/schema-validate *), Bash(pnpm test*), Bash(git diff*)
---

# Schema Validator

Tight focused check on the frozen-schema discipline declared in [ARCHITECTURE.md §VII](../../../ARCHITECTURE.md). Two things happen:

1. **Detect which schemas you touched** by diffing `packages/types/src/*.ts` against `HEAD`.
2. **Run the schema-gate tests** under `packages/types/src/__tests__/` — these are the mechanical CI guards (e.g. `personality-field-count.test.ts`).

If both come back clean, the change does not violate schema-freeze. If gate tests fail, the schema drifted without a counter bump and the change is unmergeable.

## Usage

```bash
.agents/skills/schema-validator/scripts/schema-validate
```

No arguments — runs against the current working tree (uncommitted + staged).

## Output shape

```json
{
  "touched_schemas": [
    "packages/types/src/personality.ts",
    "packages/types/src/agent-event.ts"
  ],
  "gate_tests": {
    "passed": 4,
    "failed": 0,
    "details": []
  },
  "verdict": "ok"
}
```

When `failed > 0`, `details` lists the failing gate test names and their assertion messages. `verdict` is `"ok"`, `"gate_failed"`, or `"unchanged"` (no schema files touched).

## When to use

- Touching any file under `packages/types/`.
- Adding, removing, or renaming a field on PersonalityConfig, AgentEvent, Tool, ContextEngine, Storage, plugin contract, or any other frozen interface.
- Before invoking `/openai-reviewer` if the diff includes schema changes — keeps review focused on architecture rather than mechanical schema drift.

## When NOT to use

- For changes that don't touch `packages/types/` — `verdict` will be `"unchanged"` and the call is wasted.
- As a substitute for `pnpm check` — this is one slice of the full gate, not a replacement.

## Acting on failures

A failing gate test is a hard signal: you added/removed a schema field without bumping the counter file (e.g. `.personality-field-count`). The fix is one of:

1. **You meant to change the schema** → bump the counter file in the same commit and add a CHANGELOG entry per ARCHITECTURE.md §VI.
2. **You didn't mean to** → revert the schema-touching change.

Per [CLAUDE.md](../../../CLAUDE.md): schema changes require the `personality-schema-change` label and two-maintainer approval. This skill flags drift; it does not authorize it.

## Read-only

Runs gate tests and reads `git diff`. Does not modify the codebase or counter files.
