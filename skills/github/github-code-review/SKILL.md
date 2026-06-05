---
name: github-code-review
description: Review someone else's PR. Clones into an isolated worktree under ~/.ethos/review-worktrees/ so the user's main checkout is untouched, walks the diff, posts inline comments grouped by severity. Cleans up the worktree on completion.
version: 1.0.0
author: ethosagent
tags: [coding, github, review]
required_tools: [terminal, read_file]

ethos:
  external_cli_alternatives:
    - gh
  category: github-workflow
  default_personalities: [reviewer, engineer]
  prerequisites:
    external_cli: [gh, git]
    auth: ["gh auth login (one-time browser-based flow)"]
    env_vars: []
    optional_tools: [search_files]
  integrates_with:
    - skill: code-review
      role: shares the convention-reading and severity-grouping logic; this skill applies it against a remote PR
  surface_metadata:
    invocation_trigger: "user says 'review PR #123' / pastes a PR URL / 'code-review this'"
    estimated_turns: "5-15"
---

# GitHub Code Review

Reviewing a PR is a *read-and-comment* action — never modify the user's main working tree.

## When to use this skill

- The user said "review PR #123" / "look at this PR" / "code-review this".
- The user pasted a PR URL.
- The user is on-call to review and is going through a queue of PRs.

## Step 1 — fetch metadata

```bash
gh pr view <number> --json number,title,author,body,baseRefName,headRefName,additions,deletions,files
```

Read the title, body, and base branch. Note the size — if `additions + deletions > 1000`, warn the user that the review will be slower and ask whether to focus on specific files.

## Step 2 — check out into an isolated worktree

```bash
mkdir -p ~/.ethos/review-worktrees
gh pr checkout <number> --branch pr-<number> --recurse-submodules
git -C <main-repo> worktree add ~/.ethos/review-worktrees/<number> pr-<number>
```

The user's main checkout is **never** touched. All file reads in subsequent steps reference the worktree path.

If a worktree at `~/.ethos/review-worktrees/<number>` already exists from a prior run, prune-and-recreate (do **not** silently use a stale worktree).

## Step 3 — read project conventions

Same logic as the local `code-review` skill: read `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `DESIGN.md`, `CONTRIBUTING.md` from the **worktree** (the PR may have updated them).

## Step 4 — walk the diff

```bash
gh pr diff <number>
```

For each changed file, apply the same review categories as the local `code-review` skill (security, quality, conventions). Tag every finding with:

- File and line (use the post-image line number — that's what GitHub expects for inline comments).
- Severity: `critical | warning | suggestion | nit`.
- Optional: a one-line suggested change.

## Step 5 — group findings

```markdown
## Critical
- `<path>:<line>` — <issue>

## Warning
- ...

## Suggestion
- ...

## Nit
- ...
```

A nit is a stylistic preference with no impact on correctness — surface them under their own header so they are easy to skip.

## Step 6 — post the review

Two posting modes; the user picks.

**Inline comments (preferred for line-specific findings):**
```bash
gh api -X POST /repos/<owner>/<repo>/pulls/<number>/comments \
  -f body='<comment>' -f commit_id='<head-sha>' -f path='<file>' -F line=<line>
```

**Single review comment with the grouped findings (better for cross-cutting feedback):**
```bash
gh pr review <number> --comment --body-file <findings.md>
```

For the review verdict (request changes vs approve vs comment-only), let the user decide. Do **not** auto-approve or auto-request-changes.

## Step 7 — clean up

```bash
git worktree remove ~/.ethos/review-worktrees/<number> --force
```

Always remove the worktree when the review is finished. Stale worktrees accumulate fast.

## Hard rules

- **Never modify the PR.** This skill reads and comments. It does not push, not even formatting fixes — that's the author's call.
- **Never approve without explicit instruction.** Approval is a personal endorsement; the agent does not own one.
- **Worktree cleanup is mandatory.** Every checkout must be paired with a remove. Set up the cleanup as the first thing on completion, before exiting.
