---
name: requesting-code-review
description: Prepare a change for review *before* pushing the PR — pre-commit security + quality gate, lint + typecheck + test, then a self-review against the project's rules. Pairs with `code-review` (this skill teaches the requester; `code-review` is the reviewer's playbook).
version: 1.0.0
author: ethosagent
tags: [coding, quality, review, pre-commit]
required_tools: [read_file, terminal]

ethos:
  category: quality-and-testing
  default_personalities: [engineer]
  prerequisites:
    external_cli: [git]
    auth: []
    env_vars: []
    optional_tools: [patch_file, search_files]
  integrates_with:
    - skill: code-review
      role: companion — same convention sources (CLAUDE.md / AGENTS.md / DESIGN.md), this skill runs the gates pre-push; the companion runs the review itself
    - skill: github-pr-workflow
      role: prereq — run this skill BEFORE invoking github-pr-workflow's Step 5 (open PR)
  surface_metadata:
    invocation_trigger: "user says 'I'm about to push', 'pre-commit check', 'ship-ready?'; agent self-invokes after substantial edits and before suggesting `gh pr create`"
    estimated_turns: "1-3"
---

# Requesting Code Review

The pre-flight your change goes through before a human is asked to look at it. The goal: do not waste a reviewer's time on issues a script could have caught.

## When to use this skill

- Substantial edits are complete and tests pass locally.
- The next natural action is `git push` + `gh pr create`.
- User said "I'm ready to push" / "self-review before I commit" / "pre-commit".

## When NOT to use this skill

- Mid-spike — code is still throwaway.
- One-line typo fix — running the full gate is overkill.
- The change is already on a PR and CI is running — read CI output instead.

## Step 1 — capture the diff

```bash
git diff --stat                       # quick scope check
git diff --staged 2>/dev/null         # staged-only (preferred for the actual review)
git diff main...HEAD                  # branch-scoped fallback if nothing staged
```

If the diff is empty, stop. There is nothing to review.

## Step 2 — local gates

Run these in order. Each must pass before proceeding to the next.

```bash
# 1. Typecheck — surfaces signature mistakes before behaviour
pnpm typecheck    # or: tsc --noEmit / mypy . / cargo check

# 2. Lint — auto-fix first, then verify clean
pnpm lint:fix && pnpm lint
# (substitute project-appropriate command from package.json / pyproject.toml)

# 3. Tests — only the suites your change touches, then the full sweep
pnpm test
```

If any step fails, **stop and fix**. Do not paper over with `--no-verify`, `// @ts-ignore`, or `pytest -k 'not <my_failing_test>'`. The failure is the signal.

## Step 3 — self-review against project rules

Read the conventions sources, in this order, merging what you find:

| File | Role |
|---|---|
| `CLAUDE.md` / `AGENTS.md` / `.cursorrules` | Agent rules for the repo |
| `CONTRIBUTING.md` | Human-process rules |
| `ARCHITECTURE.md` / `DESIGN.md` | Structural / visual rules |

Then read every changed file with those rules in mind. For each file in the diff:

- Are new exports documented or intentionally kept private?
- Does any new public API have a test exercising the happy path + at least one error path?
- Are new error messages actionable (operator can fix without reading source)?
- Did the change touch a frozen schema? (Check `ARCHITECTURE.md` §VII or its equivalent — Ethos has explicit drift-gate tests.)
- Did unused imports, dead branches, or stale comments get removed?

## Step 4 — security gate

Even when the gate is "soft", scan for the five high-impact classes:

1. **Hardcoded secrets** — tokens, API keys, passwords, signing keys.
2. **Injection surfaces** — string-concatenated SQL near user input; unsanitised input to a shell; `dangerouslySetInnerHTML` on untrusted data.
3. **Path traversal** — user input concatenated into a file path.
4. **SSRF / open redirect** — user-controlled URL passed to `fetch` without an allowlist.
5. **Authn / authz changes** — anything that adjusts who can do what.

A finding here blocks the push. Rotate any secret that landed in `git` even briefly.

## Step 5 — package the request

Once the gates are green, prepare the PR body. The reviewer should be able to act on this without re-reading every file:

```markdown
## Summary
<1-3 sentences — what changed and why>

## Test plan
- <bulleted, verifiable steps — what the reviewer should check>

## Out of scope
<deliberate omissions — pre-empts the "why didn't you also fix X" comment>

## Related
<links to plan / issue / prior PR>
```

Title format: sentence-case, under 70 chars, imperative verb first ("Add rate limit on …", not "Adding rate limits").

## Anti-patterns

- **Skipping gates because "tests pass locally".** Lint and typecheck failures land in CI and waste a round-trip; catch them here.
- **Suppressing lint with `// biome-ignore` without a reason comment.** The reason field is the contract — "intentional X" satisfies the linter; "why X is intentional" satisfies the reviewer.
- **Auto-fix without re-running tests.** A fix that breaks behaviour is worse than the original lint warning.
- **PR title that's a question or status.** "WIP" / "Trying something" — open as Draft instead.
- **Empty "Test plan".** If you can't articulate how to verify, the reviewer can't either.

## Hard rules

- **Never push with failing gates.** A red local check stays red in CI.
- **Never use `--no-verify` to skip hooks.** Hooks exist because someone got burnt; fix the root cause.
- **Security findings block the push.** No exceptions.
- **Frozen schema changes require the §VII ritual.** If the project documents one (Ethos does), follow it — two-maintainer approval, CHANGELOG entry, in-lockstep test update.
