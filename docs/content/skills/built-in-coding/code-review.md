---
title: code-review
sidebar_position: 5
---

# Code Review

> Pre-commit gate. Reviews staged or branch-scoped diff for security issues, quality regressions, and adherence to project conventions. Auto-fixes safe items; flags judgment calls.

## What it does

A scoped, on-demand review — not a passive ruleset applied every turn. The skill reads the project's documented conventions (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `DESIGN.md`, `CONTRIBUTING.md`), then walks the staged diff (or `main...HEAD` if nothing is staged) and groups findings into critical / warning / suggestion buckets.

Findings tagged `auto_fix: true` are applied via `patch_file` immediately. Everything else is surfaced for the user to act on.

## When the agent uses it

- User said "review these changes", "self-review before I commit", "look this over".
- Agent self-invokes after substantial edits to >3 files when about to hand back to the user.

## Prerequisites

| Requirement | How to install / configure | Verify |
|---|---|---|
| `git` | System install | `git --version` |
| `read_file`, `terminal` | Built-in | `ethos personality show <id>` |
| `patch_file` *(optional)* | Built-in | Required to apply auto-fixes |

## Default personalities

Enabled for: `engineer`. Recommended for `reviewer` once you add `terminal` to its toolset (the reviewer ships read-only by default — see [the bundle overview](./)).

## How it works

1. Reads project conventions from any of `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `DESIGN.md`, `CONTRIBUTING.md` that exist. Merges them.
2. Gets the diff: `git diff --staged`, falling back to `git diff main...HEAD`.
3. Per file, scans for:
   - **Security**: secrets, SQL/command injection, XSS, path traversal, SSRF.
   - **Quality**: unowned TODOs, missing boundary error handling, leftover unused imports/vars.
   - **Conventions**: anything in the project's documented rules that the diff violates.
4. Groups findings under `## Critical`, `## Warning`, `## Suggestion`.
5. Auto-applies items tagged `auto_fix: true` via `patch_file`; surfaces the rest.

## Related skills

- [`tdd`](./tdd) — pairs naturally; run TDD during development, then `code-review` before commit.
- [`github-code-review`](./github-code-review) — same logic applied to a remote PR via `gh`.

## Configuration

To extend the rule set, edit any of the convention files (`CLAUDE.md`, `AGENTS.md`, etc.) — the skill reads them on every invocation. There is no separate config file for this skill.

## Examples

**User:** "Self-review before I commit."

**Agent:**
1. Reads `CLAUDE.md` — captures the "no console.log in library code" rule.
2. Runs `git diff --staged`. 4 files changed.
3. Finds:
   - **Critical**: `src/auth.ts:42` — token logged via `console.log`. Auto-fix: remove.
   - **Warning**: `src/api/users.ts:103` — new TODO without ticket reference.
   - **Suggestion**: `src/api/users.ts:88` — error message could include user id.
4. Applies the auto-fix; surfaces the warning + suggestion.

## Troubleshooting

- **"No changes to review."** Either nothing is staged and `main...HEAD` is empty, or the working tree is clean. Stage what you want reviewed first.
- **Findings reference rules I don't have.** The skill only enforces what's documented in the convention files. If a finding cites a rule, that rule should be in `CLAUDE.md` (or equivalent). If it isn't, file a bug — the agent shouldn't invent rules.
- **Auto-fix applied something I disagreed with.** Inspect the diff, revert the auto-fix locally, and add a `code-review-skip` comment on the line. The skill respects per-line skip markers.
