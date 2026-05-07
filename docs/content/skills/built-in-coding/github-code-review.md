---
title: github-code-review
sidebar_position: 8
---

# GitHub Code Review

> Review someone else's PR. Clones into an isolated worktree, walks the diff, posts inline comments grouped by severity. Cleans up the worktree on completion.

## What it does

Pulls a remote PR into `~/.ethos/review-worktrees/<pr-number>/` so the user's main checkout is never touched. Reads the project's convention sources from inside the worktree (the PR may have updated them), walks the diff, and posts findings — either as inline comments on specific lines or as a single grouped review.

## When the agent uses it

- User said "review PR #123" / "look at this PR" / "code-review this".
- User pasted a PR URL.

## Prerequisites

| Requirement | How to install / configure | Verify |
|---|---|---|
| `gh` CLI | macOS: `brew install gh`; other: [cli.github.com](https://cli.github.com/) | `gh --version` |
| `gh` authentication | `gh auth login` | `gh auth status` |
| `git` worktree support | Built into modern git | `git --version` ≥ 2.5 |
| `terminal`, `read_file` | Built-in | `ethos personality show <id>` |

## Default personalities

Enabled for: `engineer`. Recommended for `reviewer` once you add `terminal` to its toolset (the reviewer ships read-only by default — see [the bundle overview](./)).

## How it works

1. `gh pr view <number>` — fetch metadata (title, body, base, head, files, sizes).
2. `git worktree add ~/.ethos/review-worktrees/<pr> <head-ref>` — isolated checkout.
3. Read project conventions from inside the worktree.
4. Walk the diff per `gh pr diff <number>`. For each file, apply the same review categories as [`code-review`](./code-review).
5. Group findings under critical / warning / suggestion / nit.
6. Post review: inline comments via `gh api` for line-level findings, or `gh pr review --comment` for cross-cutting feedback.
7. `git worktree remove --force` on completion.

## Related skills

- [`code-review`](./code-review) — local equivalent; shares convention-reading + severity-grouping logic.

## Configuration

The base path for review worktrees is `~/.ethos/review-worktrees/`. To change it, set `ETHOS_REVIEW_WORKTREES_DIR` in the personality's environment (planned for v1.1).

## Examples

**User:** "Review PR #847 in our monorepo."

**Agent:**
1. `gh pr view 847 --json ...` — captures: 12 files, +320/-180.
2. Adds `~/.ethos/review-worktrees/847/` worktree on the PR head.
3. Reads `CLAUDE.md` from inside the worktree — picks up the rule about no `console.log` in library code.
4. Walks the diff:
   - **Critical**: `extensions/auth/src/login.ts:42` — `console.log(token)` violates project rule.
   - **Warning**: `apps/web/src/cache.ts:15` — error swallowed without log.
   - **Suggestion**: `extensions/auth/src/login.ts:88` — could use the `Result<T>` type.
   - **Nit**: `apps/web/src/cache.ts:9` — import order.
5. Posts findings inline via `gh api`. Cleans up the worktree.

## Troubleshooting

- **Worktree from a previous run is in the way.** The skill prune-and-recreates rather than silently using a stale worktree. If it still complains, run `git worktree prune` manually and retry.
- **`gh api` posting fails with permissions error.** The reviewer needs PR-comment permissions on the repo. Verify with `gh auth status -t` (you need a token with `repo` scope).
- **The PR is huge (>1000 lines changed).** The skill warns and asks whether to focus on specific files. Pick the highest-risk ones; ask the author to split the rest.
- **The skill submitted an "approve" / "request changes" without instruction.** It should not — file a bug. The skill is designed to default to comment-only.
