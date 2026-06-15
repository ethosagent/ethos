---
name: github-issues
description: Create, search, triage, label, assign, comment, and close GitHub issues. Uses gh CLI with REST API fallback. Covers bulk operations and issue→PR linking.
version: 1.0.0
author: ethosagent
tags: [coding, github, issues, triage]
required_tools: [terminal]

ethos:
  external_cli_alternatives:
    - gh
  category: github-workflow
  default_personalities: [engineer, coordinator, reviewer]
  prerequisites:
    external_cli: [git, gh]
    auth: ["gh auth login (one-time browser-based flow)"]
    env_vars: []
    optional_tools: [read_file, write_file]
  integrates_with:
    - skill: github-pr-workflow
      role: link issues to PRs via `gh issue develop` or `Fixes #N` in PR body
    - skill: github-auth
      role: prereq — `gh` API calls require auth
  surface_metadata:
    invocation_trigger: "user says 'file a bug', 'triage these issues', 'close issue #N', 'search for issues about X'; agent self-invokes when discovering a bug worth tracking"
    estimated_turns: "2-6"
---

# GitHub Issues

Full issue lifecycle — create, search, triage, label, assign, comment, close, and link to PRs. Structured steps so the user can interrupt at any point.

## When to use this skill

- User wants to create, search, update, or close GitHub issues.
- Agent discovers a bug or improvement worth tracking during other work.
- User asks to triage a backlog of unlabeled or unassigned issues.

## When NOT to use this skill

- **PR reviews** — use `github-code-review` instead.
- **Opening or merging PRs** — use `github-pr-workflow` instead.
- **Repository administration** (branch protection, secrets, releases) — use `github-repo-management` instead.

## Preflight

Before any issue operation:

```bash
gh auth status          # must succeed
gh repo view --json nameWithOwner -q '.nameWithOwner'  # confirm target repo
```

If `gh` is not installed, stop and point the user to [cli.github.com](https://cli.github.com/).

## Quick reference

| Action | gh CLI | REST API fallback |
|---|---|---|
| Create | `gh issue create --title "T" --body "B"` | `POST /repos/{owner}/{repo}/issues` |
| List / search | `gh issue list --search "query"` | `GET /repos/{owner}/{repo}/issues?q=...` |
| Show | `gh issue view 42` | `GET /repos/{owner}/{repo}/issues/42` |
| Comment | `gh issue comment 42 --body "msg"` | `POST /repos/{owner}/{repo}/issues/42/comments` |
| Close | `gh issue close 42` | `PATCH /repos/{owner}/{repo}/issues/42 {"state":"closed"}` |
| Reopen | `gh issue reopen 42` | `PATCH /repos/{owner}/{repo}/issues/42 {"state":"open"}` |
| Add label | `gh issue edit 42 --add-label "bug"` | `POST /repos/{owner}/{repo}/issues/42/labels` |
| Remove label | `gh issue edit 42 --remove-label "bug"` | `DELETE /repos/{owner}/{repo}/issues/42/labels/{name}` |
| Assign | `gh issue edit 42 --add-assignee "@me"` | `POST /repos/{owner}/{repo}/issues/42/assignees` |
| Link to PR | `gh issue develop 42 -b fix-42` | Create branch + PR with `Fixes #42` in body |

Use `gh` first. Fall back to `gh api` (which handles auth headers automatically) only when `gh issue` subcommands lack a needed option.

## Creating issues

```bash
# Simple
gh issue create --title "Widget fails on empty input" --body "Steps to reproduce..."

# With labels and assignee
gh issue create \
  --title "Add rate limiting to /api/v2" \
  --label "enhancement" --label "priority:high" \
  --assignee "@me" \
  --body-file plan.md
```

## Searching issues

```bash
# Open bugs assigned to me
gh issue list --search "is:open label:bug assignee:@me"

# Issues mentioning a keyword
gh issue list --search "rate limit in:title,body"

# Issues in a milestone
gh issue list --milestone "v2.0"

# JSON output for scripting
gh issue list --search "is:open" --json number,title,labels --limit 100
```

## Triage workflow

Structured sequence for processing an untriaged backlog:

### 1. List unlabeled issues

```bash
gh issue list --search "is:open no:label" --json number,title,body --limit 50
```

### 2. Categorize each issue

Read the title and body. Assign one of:

| Category | Label | Signal |
|---|---|---|
| Defect | `bug` | "doesn't work", "error", "crash", stack traces |
| New capability | `enhancement` | "would be nice", "add support for", "feature request" |
| Question | `question` | "how do I", "is it possible", "what is" |
| Not actionable | `needs-info` | Vague description, no repro steps, unclear ask |

### 3. Set priority

| Priority | Label | Criteria |
|---|---|---|
| Critical | `priority:critical` | Data loss, security vulnerability, total outage |
| High | `priority:high` | Major feature broken, blocking multiple users |
| Medium | `priority:medium` | Non-critical bug, important enhancement |
| Low | `priority:low` | Nice-to-have, cosmetic, minor friction |

### 4. Assign

```bash
gh issue edit 42 --add-label "bug" --add-label "priority:high" --add-assignee "username"
```

### 5. Comment with status

```bash
gh issue comment 42 --body "Triaged as high-priority bug. Assigned to @username. ETA: next sprint."
```

For issues needing more information:

```bash
gh issue comment 42 --body "Thanks for reporting. Could you provide:
- Steps to reproduce
- Expected vs actual behavior
- Environment (OS, version)

Marking as needs-info until we have repro steps."
gh issue edit 42 --add-label "needs-info"
```

## Gotcha: issues endpoint returns PRs

The GitHub REST API's `/repos/{owner}/{repo}/issues` endpoint returns **both issues and pull requests**. PRs are technically issues with a `pull_request` field.

To filter correctly:
- **gh CLI search**: use `is:issue` in the search query — `gh issue list --search "is:issue is:open"`
- **REST API**: check that the `pull_request` field is absent in each response object
- **GraphQL**: use the `Issues` connection, not `IssuesAndPullRequests`

The `gh issue list` command filters this automatically. The gotcha only bites when using `gh api` directly.

## Bulk operations

### Batch labeling

```bash
# Label all issues matching a search
gh issue list --search "is:open websocket in:title" --json number -q '.[].number' | \
  xargs -I{} gh issue edit {} --add-label "component:websocket"
```

### Close stale issues

```bash
# Close issues with no activity in 90 days
gh issue list --search "is:open updated:<$(date -d '90 days ago' +%Y-%m-%d)" \
  --json number -q '.[].number' | \
  xargs -I{} sh -c 'gh issue comment {} --body "Closing due to inactivity. Reopen if still relevant." && gh issue close {}'
```

### Transfer issues

```bash
gh issue transfer 42 owner/other-repo
```

## Issue templates

### Bug report

````markdown
```markdown
## Bug report

**Describe the bug**
A clear and concise description.

**Steps to reproduce**
1. Go to '...'
2. Click on '...'
3. See error

**Expected behavior**
What you expected to happen.

**Actual behavior**
What actually happened. Include error messages or stack traces.

**Environment**
- OS: [e.g. macOS 15.1]
- Node: [e.g. 24.0]
- Version: [e.g. 1.2.3]
```
````

### Feature request

````markdown
```markdown
## Feature request

**Problem**
What problem does this solve? Who is affected?

**Proposed solution**
How should it work? Be specific.

**Alternatives considered**
What else did you consider and why did you reject it?

**Additional context**
Links, screenshots, prior art.
```
````

## Issue → PR linking

### Option 1: `gh issue develop`

Creates a branch linked to the issue and optionally opens a PR:

```bash
# Create a branch for issue 42
gh issue develop 42 --base main --name fix-widget-empty-input

# Create branch + checkout
gh issue develop 42 --base main --checkout
```

### Option 2: Keywords in PR body

Include one of these keywords in the PR title or body to auto-close the issue when the PR merges:

- `Fixes #42`
- `Closes #42`
- `Resolves #42`

For cross-repo linking: `Fixes owner/repo#42`.

Multiple issues: `Fixes #42, fixes #43`.

### Option 3: Manual linking

```bash
# Add a comment cross-referencing the PR
gh issue comment 42 --body "Fix submitted in #87."
```

## Hard rules

- **Never close an issue without a comment** explaining why (fix merged, duplicate, won't fix, stale).
- **Never bulk-close without user confirmation.** Print the list first, ask, then proceed.
- **Prefer `gh` CLI over raw API calls.** Only use `gh api` when `gh issue` subcommands lack the needed option.

## Setup the user needs to do once

1. Install `gh`: per [cli.github.com](https://cli.github.com/).
2. Authenticate: `gh auth login`. Follow the browser flow.
3. Verify: `gh auth status` should print "Logged in to github.com as ...".

# Adapted from NousResearch/hermes-agent (MIT)
