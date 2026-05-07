---
title: tdd
sidebar_position: 4
---

# TDD: Test-Driven Development

> Enforce RED → GREEN → REFACTOR. Write a failing test before any production code; make it pass with the minimum change; then refactor. Refuses to start with a broken baseline.

## What it does

Discipline, not vibes. The skill detects the project's test command, confirms the suite is green, then walks every behaviour change through one full RED-GREEN-REFACTOR cycle before the next behaviour begins.

It refuses to start when the baseline is red — because GREEN would be ambiguous if pre-existing tests were already failing. Override with `baseline_red: true` only when explicitly told.

## When the agent uses it

- User mentioned TDD, "tests-first", "write the test first".
- The agent self-invokes when adding a feature to a codebase that already has tests.

When the change is purely mechanical (rename, dead-code removal), tests are not the right gate — the skill skips itself.

## Prerequisites

| Requirement | How to install / configure | Verify |
|---|---|---|
| `read_file`, `write_file`, `patch_file`, `terminal` | Built-in | `ethos personality show <id>` |
| Test runner reachable from `terminal` | Per language: `pnpm test` / `pytest` / `cargo test` etc. | The skill auto-detects from `package.json` / `pyproject.toml` / `Cargo.toml` |
| `run_tests` tool *(optional)* | Built-in if available | Skill prefers this typed tool when present |
| `process` tool *(optional)* | Built-in | Used for `--watch` mode |
| `todo` tool *(optional)* | Phase: tool_todo | Used for iteration tracking |

## Default personalities

Enabled for: `engineer`. Opt-in for `reviewer` (the reviewer ships read-only by default — TDD writes tests, so it requires the reviewer to add `terminal`, `write_file`, and `patch_file`).

## How it works

1. **Step 0** — auto-detect the test command from project files.
2. **Step 1** — confirm baseline green. Refuses to proceed if any pre-existing test fails.
3. **Step 2** — for each new behaviour:
   - 🔴 **RED:** write the failing test; run; confirm it fails for the right reason.
   - 🟢 **GREEN:** smallest production change; run; confirm green.
   - 🧹 **REFACTOR:** clean up; run; confirm still green.
4. **Step 3** — track each iteration as a todo item if `todo` is available.
5. **Step 4** — final pass: run the full suite and the project's `check` command.

## Related skills

- [`code-review`](./code-review) — pairs naturally; run before commit, after the TDD cycle is complete.
- [`systematic-debugging`](./systematic-debugging) — when a test that should pass is unexpectedly red.

## Configuration

Override the baseline check by passing `baseline_red: true` when invoking — the skill records the override and proceeds anyway. Use this only when the broken baseline is unrelated to your work.

## Examples

**User:** "Add tests-first input validation to the signup form."

**Agent:**
1. Detects `pnpm test` from `package.json`.
2. Runs `pnpm test` — green. Proceeds.
3. RED: writes `signup.test.ts` with a case for "rejects email without @". Runs — fails with the expected assertion error.
4. GREEN: adds the smallest validation that makes the test pass. Runs — green.
5. REFACTOR: extracts validation into a named function. Runs — still green.
6. Repeats for "rejects empty password", "trims whitespace", etc.
7. Final pass: full suite green. Reports 5 cycles, 2 files touched, 5 tests added.

## Troubleshooting

- **"Baseline is red — refusing to proceed."** A pre-existing test is failing. Either fix it first, or pass `baseline_red: true` to override.
- **Test runner not detected.** The auto-detect looks for `scripts.test` in `package.json`, pytest config in `pyproject.toml`, or `Cargo.toml`. For other setups, configure the project to expose one of those, or invoke the test command manually and tell the agent the path.
- **The agent runs tests too often.** That's the discipline. Each phase ends with a test run; that's how regressions are caught immediately.
