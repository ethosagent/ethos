---
name: claude-code
description: Deep-dive reference for delegating implementation work to the Claude Code CLI. Covers print-mode invocation, structured JSON output parsing, tool scoping with --allowedTools, tmux session handling, cost and turn caps, and error recovery.
version: 1.0.0
author: ethosagent
tags: [delegation, claude-code, coding-agent]
required_tools: [terminal, process_start, process_logs, process_stop]

ethos:
  external_cli_alternatives:
    - claude
  category: delegation-and-orchestration
  default_personalities: [engineer, coordinator]
  prerequisites:
    external_cli: [claude]
    auth: ["claude auth login (one-time browser flow)"]
    env_vars: []
    optional_tools: [memory_write]
  integrates_with:
    - skill: coding-agent
      role: coding-agent routes here when claude is the chosen CLI
  surface_metadata:
    invocation_trigger: "coding-agent selected claude as the delegation target; user says 'use Claude Code for this'"
    estimated_turns: "2-5"
---

# Claude Code — Deep-Dive Delegation Reference

Comprehensive reference for spawning and managing the Claude Code CLI (`claude`) as a delegated coding agent under ethos process control.

## When to use

- **Large refactors** that span many files — Claude Code excels at holding a wide codebase context and applying systematic changes across it.
- **Multi-file edits** where the same pattern repeats across dozens of files (rename a type, update an import path, migrate an API).
- **Deep codebase reasoning** — tasks that benefit from the model reading and understanding significant portions of the code before making a change.
- **Complex debugging** where the root cause requires reading call chains across multiple packages.

**Do not use** for one-line fixes, trivial formatting changes, or tasks where the startup cost of spawning a process exceeds the value of the change. Execute those directly.

## Print mode — the core delegation pattern

Print mode (`-p` or `--print`) is the canonical invocation for delegation from a managed process. It runs Claude Code as a one-shot: send a task, receive a result, exit.

```bash
claude -p "<task description>" --output-format json
```

This is the only invocation pattern you should use for delegation. Interactive mode (`claude` without `-p`) opens a REPL and cannot be driven programmatically from `process_start`.

### Minimal example

```bash
process_start({
  command: 'claude -p "Refactor the UserService class to use dependency injection. The class is in src/services/user.ts and its tests are in src/services/__tests__/user.test.ts." --output-format json --cwd /path/to/project',
  name: 'delegated-refactor-user-di',
  cwd: '/path/to/project'
})
```

## Structured JSON output contract

When invoked with `--output-format json`, Claude Code returns a JSON object on stdout. The shape:

```json
{
  "result": "The assistant's response text — what it did, what changed, any warnings.",
  "cost_usd": 0.042,
  "duration_ms": 34200,
  "turn_count": 3,
  "input_tokens": 12400,
  "output_tokens": 4800
}
```

### Parsing pattern

After the process exits, capture stdout via `process_logs` and parse:

```
1. Read process logs (stdout).
2. Find the last complete JSON object in the output.
3. Parse it.
4. Extract `result` for the summary, `cost_usd` for budget tracking.
5. If parsing fails, treat the raw stdout as a plain-text result and flag the anomaly.
```

The `--output-format text` variant returns the result as plain text (no JSON wrapper). Use `text` when you only need the response and do not need cost data.

## Tool scoping with `--allowedTools`

Claude Code has access to a broad set of tools by default (Bash, Read, Write, etc.). Restrict what it can do with `--allowedTools`:

```bash
# Full read-write access (default behavior, but explicit):
claude -p "<task>" --allowedTools "Bash" "Read" "Write" "Edit"

# Read-only — for investigation tasks where you do not want mutations:
claude -p "<task>" --allowedTools "Read" "Bash(cat *)" "Bash(find *)" "Bash(grep *)" "Bash(rg *)"

# Git-only — for tasks that should only inspect version control:
claude -p "<task>" --allowedTools "Bash(git *)" "Read"

# Scoped write — only allow writes to a specific directory:
claude -p "<task>" --allowedTools "Read" "Write" "Bash(cd src/api && *)"
```

### Tool scoping syntax rules

- Each allowed tool is a separate argument: `--allowedTools "Bash(git *)" "Read"`.
- `Bash(pattern)` restricts Bash to commands matching the glob pattern.
- Multiple `Bash(...)` entries are OR'd — the command must match at least one.
- Omitting `--allowedTools` grants the default full toolset.

**When to restrict:** always restrict for investigation-only delegations (no accidental writes). For implementation delegations, restrict to the minimum toolset the task needs.

## Cost and turn caps

### Turn cap

Limit conversation depth with `--max-turns`:

```bash
claude -p "<task>" --max-turns 5
```

If the task is not complete after N turns, Claude Code exits with the partial result. Use this for tasks with a known upper bound on complexity.

### Cost monitoring

There is no built-in cost cap flag. Monitor cost via the JSON output:

```
1. After process completion, parse `cost_usd` from the JSON output.
2. Compare against a budget threshold (set by the orchestrator or the user).
3. If the cost exceeds the threshold, log a warning and surface it to the user.
4. For iterative delegations (retry loops), accumulate cost across runs.
```

A reasonable budget threshold for most single-task delegations: $0.10 for small tasks, $0.50 for medium refactors, $2.00 for large multi-file changes. Surface a warning at 80% of the threshold.

## Tmux session handling

When Claude Code runs inside a tmux pane (common in ethos's process model), it may emit interactive permission prompts to the PTY. Two strategies:

### Strategy 1: `--yes` flag (auto-approve)

```bash
claude -p "<task>" --yes --allowedTools "Bash" "Read" "Write"
```

`--yes` auto-approves tool invocations that Claude Code would normally prompt for. Combine with `--allowedTools` to restrict the scope of what gets auto-approved.

### Strategy 2: Full-auto delegation

```bash
claude -p "<task>" --yes --allowedTools "Bash" "Read" "Write" "Edit" --max-turns 10 --output-format json --cwd /path/to/project
```

This is the canonical "fire and forget" invocation for a fully automated delegation. The orchestrator spawns it, monitors logs, and collects the result.

### When NOT to use `--yes`

- When the task involves destructive operations (deleting files, force-pushing, dropping databases).
- When the user has explicitly asked for confirmation before changes.
- When delegating to an unfamiliar codebase where the blast radius is unknown.

In these cases, omit `--yes` and monitor the process interactively.

## Working directory

Always set the working directory explicitly with `--cwd`:

```bash
claude -p "<task>" --cwd /absolute/path/to/project
```

Do not rely on the shell's current directory — `process_start` may not inherit it consistently. The `--cwd` flag is the single source of truth for where Claude Code operates.

## Error recovery

### Common failure modes

| Exit code | Cause | Recovery |
|---|---|---|
| Non-zero, stderr contains `auth` | Auth token expired or revoked | Re-run `claude auth login` and retry |
| Non-zero, stderr contains `context` or `token` | Context window exceeded | Split the task into smaller pieces; reduce `--allowedTools` to limit tool output |
| Non-zero, stderr contains `rate` | Rate limited by the API | Wait 60 seconds and retry; if persistent, check usage dashboard |
| Non-zero, stderr contains `timeout` | Process timed out | Increase the timeout or split the task |
| Non-zero, no stderr | Process killed by OS (OOM, signal) | Check system resources; retry with a simpler task |

### Recovery pattern

```
1. Capture exit code and stderr from process_logs.
2. Match stderr against known failure patterns (table above).
3. If recoverable: apply the recovery action and retry (max 2 retries).
4. If not recoverable: surface the error to the user with the raw stderr.
5. Never silently swallow a non-zero exit.
```

## Session continuation

For multi-step delegations where context should carry over between invocations:

```bash
# Resume the most recent session for this directory:
claude -p "<follow-up task>" --continue --cwd /path/to/project

# Resume a specific session by ID:
claude -p "<follow-up task>" --session-id abc123 --cwd /path/to/project
```

Use `--continue` when a delegation needs a second pass (e.g., "now add tests for what you just changed"). The session retains the full conversation history, so the follow-up has context.

Use `--session-id` when managing multiple parallel delegations and you need to resume a specific one.

## Model override

Override the default model with `--model`:

```bash
claude -p "<task>" --model claude-sonnet-4-6
claude -p "<task>" --model claude-opus-4-7
```

When to override:
- **Cheaper model** for simple, well-scoped tasks (sonnet).
- **Stronger model** for complex reasoning, architecture decisions (opus).
- **User request** — if the user specifies a model, pass it through.

If the user did not specify, do not override — let Claude Code use its default.

## Delegation checklist

Before spawning a Claude Code delegation, verify:

1. `which claude` succeeds — the CLI is installed.
2. `claude auth status` succeeds — auth is configured.
3. `--cwd` points to the correct project root.
4. `--allowedTools` is scoped to the minimum needed.
5. `--output-format json` is set (for structured result parsing).
6. A `process_start` name is chosen (descriptive slug).
7. A cost budget and turn cap are set (if applicable).
8. The user has authorized the delegation.

## Hard rules

- **Always use print mode (`-p`).** Interactive mode cannot be driven from `process_start`.
- **Always set `--cwd`.** Implicit working directory is a source of bugs.
- **Always parse the exit code.** A zero exit with no JSON output is still a failure — the process may have been killed mid-stream.
- **Never delegate without the process tool.** Without `process_start`, the orchestrator blocks for the full duration and the user cannot kill the delegation.
- **Never auto-approve (`--yes`) destructive operations** without explicit user authorization.

# Adapted from NousResearch/hermes-agent (MIT)
