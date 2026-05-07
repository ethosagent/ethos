---
name: coding-agent
description: Delegate file-heavy implementation work to a specialized coding CLI (Claude Code / Codex / OpenCode / Pi). Runs the delegated CLI inside the process tool — full audit logs, kill control, session record. Used by the coordinator pattern when "implement this feature, here are the files" is the request.
version: 1.0.0
author: ethosagent
tags: [coding, delegation, orchestration]
required_tools: [terminal, process_start, process_logs, process_stop]

ethos:
  category: delegation-and-orchestration
  default_personalities: [coordinator]
  prerequisites:
    # At least one of these must be installed — the skill routes to whichever
    # CLI is present (or the user-specified one). `ethos doctor` treats the
    # `any_of` shape as "warn only when none are reachable".
    external_cli:
      - any_of: [claude, codex, opencode, pi]
    auth: ["per CLI — see adapter files"]
    env_vars: ["depends on the chosen CLI; OpenAI Codex CLI may need OPENAI_API_KEY"]
    optional_tools: [memory_write]
  integrates_with:
    - tool: process_start
      role: spawn the delegated CLI as a managed process so the user can audit and kill it
    - tool: process_logs
      role: surface progress to the user without blocking the chat
  surface_metadata:
    invocation_trigger: "user says 'have Claude Code do this' / 'delegate to codex' / 'use opencode for this'; coordinator decides delegation is appropriate for large file-heavy work"
    estimated_turns: "1-5 from the orchestrator's perspective; the delegated CLI may run for many minutes internally"
---

# Coding Agent (delegation)

When the work is "implement this feature, here are the files," delegate to a specialized coding CLI. This skill runs the chosen CLI inside the `process` tool so the user has full audit + kill control, and records the delegation under `~/.ethos/delegations/<id>/` for replay.

## When to use this skill

- The user explicitly named a CLI: "have Claude Code do this", "delegate to codex".
- The coordinator pattern is active and the work is large, file-heavy, or requires sustained editing across many files.
- The work is "implement this feature with these constraints" rather than "decide what to build" — delegation is for execution, not planning.

When the change is small (one file, a few lines), do not delegate — execute it directly.

## Step 1 — pick the right CLI

| CLI | Best for | Adapter |
|---|---|---|
| `claude` (Claude Code) | Large refactors, multi-file edits, deep codebase reasoning | [adapters/claude-code.md](./adapters/claude-code.md) |
| `codex` (OpenAI Codex CLI) | Fast iteration loops, smaller scoped changes | [adapters/codex.md](./adapters/codex.md) |
| `opencode` (OpenCode) | Provider-flexible — when the user wants a specific non-Anthropic, non-OpenAI model | [adapters/opencode.md](./adapters/opencode.md) |
| `pi` (Inflection) | Natural conversation flow, lighter touch on code | [adapters/pi.md](./adapters/pi.md) |

If the user did not specify, ask. Do not silently pick one.

## Step 2 — verify the chosen CLI is installed and authenticated

Run the adapter's check commands before spawning. Each adapter file documents:

- The `which <cli>` test (or platform equivalent).
- The version check.
- The auth status check.
- The error to print if any of those fail (with the exact install + login command for the user to run).

**Refuse to delegate** if the CLI is not installed or not authenticated. A graceful refusal beats spawning a process that fails opaquely.

## Step 3 — spawn via the process tool

```
process_start({
  command: "<cli> <args>",
  name: "delegated-<id>",
  cwd: <project-root>,
})
```

Capture the returned `process_id`. The `id` part of the name is a short slug derived from the request (e.g. `delegated-rate-limit-2026-05-06-1430`).

Pass any context the delegated CLI needs through its own argument or stdin convention — see the adapter files.

## Step 4 — watch logs

Use `process_logs` to surface progress to the user. Two patterns:

- **Tight feedback** (small delegations): poll logs every 10-30 seconds, summarize what the CLI is doing.
- **Long delegations**: tell the user "delegated; I'll surface progress when there's a meaningful update", then check logs only when explicitly asked or when `process_wait` indicates completion.

Never silently let a delegated process run forever. Set a time-box up front and check it.

## Step 5 — handle completion

When the delegated CLI exits:

1. Capture exit code, total runtime, and the final log lines.
2. Record the session under `~/.ethos/delegations/<slug>/`:
   ```
   <slug>/
   ├── command.txt          # the exact command spawned
   ├── stdout.log           # full stdout
   ├── stderr.log           # full stderr
   ├── files-touched.txt    # list of files the delegated CLI modified
   └── result.md            # summary, exit code, recommendation
   ```
3. Summarize the result back to the user: success / partial / failure, what changed, whether to merge or roll back.

## Step 6 — clean up

If the user is done with the delegation, the session record stays for replay but the running process is gone (it already exited). If the user interrupted mid-flight, kill the process with `process_stop` before exiting the skill.

## Hard rules

- **Never spawn a delegated CLI without the `process` tool.** Without it, the chat blocks for the full delegation duration and the user can't kill it. Refuse delegation and surface the prerequisite gap.
- **Never delegate work the user has not authorized.** Coordinator personalities should ask before delegating, not after.
- **Always record the session.** A delegation that is not auditable is a delegation that cannot be debugged.
