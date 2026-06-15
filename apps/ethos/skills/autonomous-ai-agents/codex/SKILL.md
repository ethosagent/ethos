---
name: codex
description: Deep-dive reference for delegating implementation work to the OpenAI Codex CLI. Covers exec mode, full-auto approval, git-repo requirement, output parsing, and batch workflows (worktree-parallel issue fixes, batch PR reviews).
version: 1.0.0
author: ethosagent
tags: [delegation, codex, coding-agent]
required_tools: [terminal, process_start, process_logs, process_stop]

ethos:
  external_cli_alternatives:
    - codex
  category: delegation-and-orchestration
  default_personalities: [engineer, coordinator]
  prerequisites:
    external_cli: [codex]
    auth: ["OPENAI_API_KEY in environment, or codex login"]
    env_vars: ["OPENAI_API_KEY (or use codex login)"]
    optional_tools: [memory_write]
  integrates_with:
    - skill: coding-agent
      role: coding-agent routes here when codex is the chosen CLI
    - skill: openai-reviewer
      role: codex-as-coding-worker here vs codex-as-reviewer in openai-reviewer — keep them separate
  surface_metadata:
    invocation_trigger: "coding-agent selected codex as the delegation target; user says 'use Codex for this'"
    estimated_turns: "2-5"
---

# Codex CLI — Deep-Dive Delegation Reference

Comprehensive reference for spawning and managing the OpenAI Codex CLI (`codex`) as a delegated coding agent under ethos process control.

## When to use

- **Fast iteration** on smaller, well-scoped changes — Codex is optimized for speed over deliberation.
- **Second opinion** — when the user wants a different model family's perspective on a problem.
- **Quick prototypes** where turnaround matters more than deep codebase reasoning.
- **Batch operations** — Codex's `exec` mode is well-suited for parallelized workflows (multiple worktrees, multiple PRs).

**Do not use** for deep multi-file reasoning where the model needs to read and understand large portions of the codebase before acting. Claude Code is better suited for that. Also avoid for tasks requiring nuanced architectural decisions.

## Hard rules

These are non-negotiable constraints of the Codex CLI:

### PTY-mandatory

Codex expects a real terminal (PTY). Always spawn via `process_start`, which provides one. Running Codex via a bare `exec()` or piped subprocess will produce garbled output or hang.

### Git repo requirement

Codex refuses to work outside a git repository. Before delegating, verify the target directory is inside a git repo:

```bash
git -C /path/to/project rev-parse --is-inside-work-tree
```

If this fails, Codex will error out immediately. Either initialize a git repo or choose a different delegation target.

### `exec` mode for one-shots

```bash
codex exec "<task description>"
```

`exec` runs the task and exits. This is the only invocation pattern for delegation from `process_start`. Do not use interactive mode — it cannot be driven programmatically.

### `--full-auto` for unattended operation

```bash
codex exec "<task description>" --full-auto
```

`--full-auto` auto-approves all operations (file writes, shell commands, etc.) without prompting. This is required for unattended delegations but must be used with care.

## Invocation patterns

### Minimal delegation

```bash
process_start({
  command: 'codex exec "Add input validation to the createUser endpoint in src/api/users.ts" --full-auto',
  name: 'delegated-codex-add-validation',
  cwd: '/path/to/project'
})
```

### With model selection

```bash
codex exec "<task>" --full-auto --model o4-mini
```

Use cheaper models for simpler tasks to control cost.

### With working directory

```bash
cd /path/to/project && codex exec "<task>" --full-auto
```

Codex does not have a `--cwd` flag — set the working directory via `cd` before invocation, or set `cwd` in the `process_start` call (which handles this).

## Output parsing

Codex outputs plain text to stdout by default. There is no structured JSON mode.

### Parsing strategy

```
1. Capture stdout from process_logs after the process exits.
2. The exit code is the primary success indicator:
   - 0 = task completed successfully
   - Non-zero = failure (stderr contains the error)
3. Parse stdout for the result summary — Codex typically outputs a description
   of what it changed at the end.
4. For file-level change tracking, run `git diff --name-only` after completion
   to see what Codex modified.
```

### Exit code interpretation

| Exit code | Meaning |
|---|---|
| 0 | Task completed |
| 1 | Task failed (general error) |
| Non-zero + `rate` in stderr | Rate limited — wait and retry |
| Non-zero + `auth` in stderr | Authentication failure — check OPENAI_API_KEY |

## Cost discipline

Codex does not report cost in its output. Monitor token usage indirectly:

1. **Model selection** — use `--model` to pick cheaper models for simpler tasks. `o4-mini` is significantly cheaper than the default for well-scoped changes.
2. **Task scoping** — smaller, more specific tasks use fewer tokens. "Fix the null check in processOrder" is cheaper than "review and fix all error handling".
3. **Process duration** — longer runtime correlates with higher cost. Set a time-box in the orchestrator and kill the process if it exceeds it.
4. **Post-hoc tracking** — check the OpenAI usage dashboard after batch operations to calibrate your cost estimates.

## Batch workflows

Codex's fast `exec` mode makes it well-suited for parallelized batch operations.

### Worktree-parallel issue fix

For a list of independent issues, create a git worktree per issue and run Codex in each:

```
For each issue in the batch:
  1. Create a feature branch: git checkout -b fix/<issue-slug>
  2. Create a worktree: git worktree add /tmp/worktree-<issue-slug> fix/<issue-slug>
  3. Spawn:
     process_start({
       command: 'codex exec "Fix issue: <issue-title>. Details: <issue-body>" --full-auto',
       name: 'delegated-codex-<issue-slug>',
       cwd: '/tmp/worktree-<issue-slug>'
     })
  4. After completion, verify with: git -C /tmp/worktree-<issue-slug> diff
  5. If the diff looks correct, commit and create a PR.
  6. Clean up: git worktree remove /tmp/worktree-<issue-slug>
```

This parallelizes naturally — each worktree is independent. Run up to 3-5 concurrent delegations depending on API rate limits.

### Batch PR review

For a list of open PRs, run a review pass on each:

```
For each PR:
  1. Fetch the diff: gh pr diff <pr-number>
  2. Spawn:
     process_start({
       command: 'codex exec "Review this PR diff for bugs, security issues, and style violations:\n<diff>" --full-auto',
       name: 'delegated-codex-review-pr-<pr-number>',
       cwd: '/path/to/repo'
     })
  3. Capture the review output from process_logs.
  4. Post the review as a PR comment.
```

**Note:** this uses Codex as a coding worker, not as a code reviewer. The `openai-reviewer` skill in ethos uses Codex specifically for the review framing — keep the two roles separate. Use this batch pattern when you want a model to *do work* on each PR (e.g., apply fixes), not just comment.

## Safety

### `--full-auto` risk assessment

`--full-auto` is powerful but dangerous. It auto-approves:
- File writes and deletions
- Shell command execution
- Package installations

**Mitigation rules:**
1. **Never use on a production branch.** Always work in a feature branch or worktree.
2. **Scope the task tightly.** "Fix the null check in src/api/users.ts line 42" is safer than "fix all bugs".
3. **Review the diff after completion.** `git diff` before committing anything Codex produced.
4. **Set a time-box.** Kill the process if it runs longer than expected — runaway loops are expensive.
5. **Use worktrees for isolation.** A worktree can be discarded entirely if the result is bad.

### Pre-delegation safety checklist

1. The target directory is a git repo (Codex requirement).
2. The current branch is a feature branch, not main/master.
3. There are no uncommitted changes that could be overwritten.
4. `--full-auto` is intentional and the user has authorized unattended operation.
5. A time-box is set in the orchestrator.

## Authentication

### API key method

Set `OPENAI_API_KEY` in the environment before spawning:

```bash
export OPENAI_API_KEY=sk-...
codex exec "<task>" --full-auto
```

### Login method

```bash
codex login
```

Opens a browser flow. After completion, Codex stores the session token locally.

### Verification

```bash
which codex                          # installed?
codex --version                      # which version?
[ -n "$OPENAI_API_KEY" ] || codex auth status  # authenticated?
```

If any check fails, refuse the delegation and print the specific remediation step.

## Error recovery

| Failure | Cause | Recovery |
|---|---|---|
| "not a git repository" | Codex ran outside a git repo | Ensure `cwd` points inside a git working tree |
| Rate limit error | API rate limit exceeded | Wait 60 seconds, retry. For batch workflows, reduce parallelism |
| Auth error | OPENAI_API_KEY invalid or expired | Re-set the key or re-run `codex login` |
| Process hangs | Waiting for interactive input | Ensure `--full-auto` is set; kill and retry |
| Garbled output | No PTY | Ensure invocation is via `process_start` (provides PTY) |

Recovery pattern: capture exit code + stderr, match against known patterns, retry up to 2 times for transient errors, surface to the user for permanent failures.

## Model selection

Override the default model with `--model`:

```bash
codex exec "<task>" --model o4-mini        # cheaper, faster
codex exec "<task>" --model o3              # stronger reasoning
```

Guidelines:
- **Simple, well-scoped tasks:** use a cheaper model to save cost.
- **Complex logic or reasoning:** use the strongest available model.
- **User preference:** if the user specifies a model, pass it through.
- **No override:** if no preference, let Codex use its default.

# Adapted from NousResearch/hermes-agent (MIT)
