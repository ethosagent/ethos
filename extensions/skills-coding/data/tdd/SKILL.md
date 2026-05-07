---
name: tdd
description: Enforce RED → GREEN → REFACTOR. Write a failing test before any production code; make it pass with the minimum change; then refactor. Refuses to start with a broken baseline.
version: 1.0.0
author: ethosagent
tags: [coding, testing, quality]
required_tools: [read_file, write_file, patch_file, terminal]

ethos:
  category: quality-and-testing
  default_personalities: [engineer, reviewer]
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: [run_tests, process, todo]
  integrates_with:
    - tool: process
      role: leave the test runner in --watch mode in the background while iterating
    - tool: todo
      role: track each RED-GREEN-REFACTOR iteration as an auditable todo item
    - tool: run_tests
      role: prefer this typed tool over raw `terminal` invocations when present
  surface_metadata:
    invocation_trigger: "user mentions tests, TDD, tests-first; agent self-invokes when adding a feature to a codebase that has existing tests"
    estimated_turns: "5-15 per feature (one full RED-GREEN-REFACTOR is typically 1-2 turns)"
---

# TDD: Test-Driven Development

Discipline, not vibes. Every behaviour change goes through one full RED → GREEN → REFACTOR cycle before the next behaviour begins.

## When to use this skill

- The user mentioned TDD, tests-first, "write the test first".
- You are adding behaviour to a codebase that already has tests. Match the established discipline.
- You are about to write production code for a non-trivial change and there is no test that will catch a regression.

When the change is purely mechanical (rename, formatting, dead-code removal) tests are not the right gate — skip TDD.

## Step 0 — detect the test command

Before doing anything else, find the project's test runner:

| Marker file | Test command |
|---|---|
| `package.json` with `scripts.test` | run that script (`pnpm test` / `npm test`) |
| `package.json` with `scripts.check` | run that script first if it composes test + lint + typecheck |
| `pyproject.toml` with pytest config | `pytest` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |

Use the `run_tests` tool when available; fall back to `terminal` otherwise.

## Step 1 — confirm baseline green

Run the test suite **once** before writing anything new.

- All green → proceed.
- Any failure → **stop**. Tell the user: "baseline is red — fix existing tests first or pass `baseline_red: true` to override". Refuse to start a TDD cycle on top of pre-existing failures, because GREEN will be ambiguous.

## Step 2 — the cycle

For each behaviour:

### 🔴 RED
1. Write the failing test. One concrete assertion at a time.
2. Run the suite. The new test must fail. Inspect *why* it failed:
   - It must fail for the **expected reason** (assertion mismatch), not a syntax error or a missing import.
   - If it fails for the wrong reason, fix that and re-run before continuing.

### 🟢 GREEN
1. Write the **smallest** production change that makes the new test pass. Hardcoding a return value is acceptable here — multiple tests will force generalization.
2. Run the suite. The new test plus all prior tests must be green.
3. If anything regresses, the GREEN step is incomplete — keep going.

### 🧹 REFACTOR
1. Improve the code without changing behaviour. Extract, rename, simplify.
2. Run the suite **after each refactor** — refactors that break tests are no longer refactors, they're behaviour changes.
3. Stop refactoring when no further improvement is obvious.

## Step 3 — track the cycle

If the `todo` tool is available, write each RED-GREEN-REFACTOR as a todo item. The user can see exactly what behaviour each cycle covered. This also forces small, focused cycles.

## Step 4 — final pass

Once all behaviours are covered:

1. Run the full test suite.
2. Run the project's `check` command (lint + typecheck + test in one) if it exists.
3. Report: number of cycles, files touched, tests added.

## Hard rules

- **No production code without a test that drove it.** If you find yourself editing production code with no failing test that needs it, stop — write the test first.
- **No fix lands with a red baseline.** Override with `baseline_red: true` only when explicitly told.
- **One cycle, one behaviour.** If a single test forces you to write four new methods, the test is too broad — split it.

## Integrates with

- `process` tool — start `pnpm test --watch` (or the project equivalent) once at the top of the cycle, leave it running, watch the output between iterations. Kill it with `process_stop` at the end.
- `run_tests` — use the typed tool when available; cleaner output and better error reporting than parsing `terminal`.
