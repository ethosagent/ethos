---
name: github-pr-workflow
description: End-to-end PR lifecycle — branch, commit, push, open PR, watch CI, merge. Each step structured; user can interrupt anywhere. Uses `gh` CLI; pairs with the process tool for non-blocking CI watch.
version: 1.0.0
author: ethosagent
tags: [coding, github, workflow]
required_tools: [terminal, read_file, write_file]

ethos:
  category: github-workflow
  default_personalities: [engineer, coordinator]
  prerequisites:
    external_cli: [gh, git]
    auth: ["gh auth login (one-time browser-based flow)"]
    env_vars: []
    optional_tools: [process]
  integrates_with:
    - tool: process
      role: run `gh pr checks --watch` as a background process so the user can keep working while CI runs
  surface_metadata:
    invocation_trigger: "user says 'open a PR' / 'submit this for review' / 'PR this'; agent self-invokes after feature complete + tests pass"
    estimated_turns: "3-10 (CI wait dominates wall-clock time)"
---

# GitHub PR Workflow

Linear, structured walk through branch → commit → push → PR → CI → merge. Every step prints what it did so the user can interrupt.

## When to use this skill

- User said "open a PR", "submit this for review", "let's PR this".
- A feature is complete, tests pass, and the next natural action is publishing.

When changes are not yet test-clean, **do not** invoke this skill — finish the change first.

## Step 0 — preflight

Run these checks before the first git command. Each one prints its result and only proceeds when the user has not interrupted.

- `gh auth status` — must succeed. If not, stop and tell the user: "run `gh auth login` and retry".
- `git remote -v` — at least one remote configured.
- `git status --porcelain` — capture the dirty state for step 1.

If `gh` is not installed: stop and print the install command (`npm i -g @anthropic-ai/claude-code` is the wrong one; use the platform-specific install per [cli.github.com](https://cli.github.com/)).

## Step 1 — clean working tree

Either commit/stash existing changes, or fold them into the PR you are about to open. Ask the user when ambiguous; do not silently stash.

## Step 2 — create the branch

Branch off `main` (or the repo's default branch — read it from `gh repo view --json defaultBranchRef`).

```bash
git switch -c <branch-name>
```

Branch name conventions:
- kebab-case
- start with the imperative verb of the change: `add-rate-limit`, `fix-stale-cache`
- if there's a tracking issue, prefix with the number: `1234-add-rate-limit`

## Step 3 — commit

One commit per coherent change. Commit message format:

```
<scope>: <imperative summary>

<optional body explaining why, not what>
```

For large changes, prefer multiple focused commits over one monster commit. The PR is the unit of review; the commits inside it tell the story of how the change was constructed.

## Step 4 — push

```bash
git push -u origin <branch-name>
```

Never use `--force` or `--force-with-lease` here. This is a fresh branch with no upstream history to overwrite.

## Step 5 — open the PR

```bash
gh pr create --title "<title>" --body "<body>"
```

Body shape:

```markdown
## Summary
<1-3 sentences>

## Test plan
- <bulleted checklist of what to verify>

## Related
<links to issues / docs / prior PRs>
```

Title is a single line, sentence-case, under 70 characters.

## Step 6 — watch CI

Two paths depending on tool availability:

- **With `process` tool:** start `gh pr checks --watch` as a background process. The chat is not blocked; the user can keep working. Poll status with `process_logs` when the user asks.
- **Without `process` tool:** run `gh pr checks --watch` synchronously, but warn the user this will block the chat until CI finishes.

## Step 7 — handle the result

**On green:** print the PR URL. Ask the user whether to merge. Do not auto-merge.

**On red:**
1. Read the failed checks: `gh pr checks <number> --json name,state,conclusion`
2. For the first failure, fetch logs and propose a fix.
3. Apply the fix on the branch, push, return to Step 6.

## Hard rules

- **Never auto-merge.** Merge is a deliberate action by the user, even when CI is green.
- **Do not push to `main` directly.** This skill is PR-only.
- **Never use `--no-verify` to skip hooks.** If a pre-commit hook fails, fix the underlying issue.

## Setup the user needs to do once

1. Install `gh`: `brew install gh` (macOS), per [cli.github.com](https://cli.github.com/) for other OSes.
2. Authenticate: `gh auth login`. Follow the browser flow.
3. Verify: `gh auth status` should print "Logged in to github.com as ...".
