---
title: coding-agent
sidebar_position: 9
---

# Coding Agent (delegation)

> When the work is "implement this feature, here are the files," delegate to a more-specialized coding CLI (Claude Code / Codex / OpenCode / Pi). Ethos stays the coordinator; uses the right tool for the job.

## What it does

Spawns an external coding CLI inside Ethos's `process` tool — full audit logs, kill control, session record. Records every delegation under `~/.ethos/delegations/<id>/` for replay. Refuses to delegate when the chosen CLI isn't installed or authenticated.

## When the agent uses it

- User explicitly named a CLI: "have Claude Code do this", "delegate to codex".
- The coordinator personality decides delegation is appropriate (large, file-heavy work).

For small changes, the skill defers — execute directly.

## Prerequisites

The skill itself needs:

| Requirement | How to install / configure | Verify |
|---|---|---|
| `terminal` | Built-in | `ethos personality show <id>` |
| `process_start`, `process_logs`, `process_stop` | Built-in (`@ethosagent/tools-process`) | Same |
| **One of** the four CLIs below | See per-CLI table | Per-CLI command |

### Per-CLI prerequisites

| CLI | Install | Auth | Detected by |
|---|---|---|---|
| **Claude Code** | `npm i -g @anthropic-ai/claude-code` | `claude auth login` (browser) | `which claude`; `claude --version`; `claude auth status` |
| **OpenAI Codex CLI** | `npm i -g @openai/codex` | `OPENAI_API_KEY` env var **or** `codex login` | `which codex`; `codex --version` |
| **OpenCode** | `npm i -g opencode-ai` | `opencode login` (provider-agnostic) | `which opencode`; `opencode --version` |
| **Pi** (Inflection) | per Inflection docs | `pi login` | `which pi`; `pi --version` |

The skill includes a setup-check at the top of its body that runs `which <cli>` and the auth check before delegating, and refuses with the exact install command if either fails.

## Default personalities

Enabled for: `coordinator`. Opt-in elsewhere.

## How it works

1. **Pick the CLI**: Claude Code (large refactors), Codex (fast iteration), OpenCode (provider-flexibility), Pi (natural conversation). Asks the user when unspecified.
2. **Verify**: runs the per-CLI install + auth checks. Refuses if either fails.
3. **Spawn**: `process_start({ command: '<cli> ...', name: 'delegated-<slug>' })`.
4. **Watch logs**: `process_logs` polls; surfaces meaningful progress to the user.
5. **Complete**: capture exit code, runtime, files-touched, final logs. Record under `~/.ethos/delegations/<slug>/`.
6. **Clean up**: kill the process if user-interrupted; otherwise the process has already exited.

## Related skills

- [`subagent-driven-development`](./subagent-driven-development) — when the work is many parallel pieces handled by Ethos team members rather than a single external CLI.

## Configuration

The session record path is `~/.ethos/delegations/<slug>/`. The slug is auto-derived from the request + timestamp (e.g. `delegated-rate-limit-2026-05-06-1430`). No knobs to turn.

## Examples

**User:** "Have Claude Code refactor the auth module to use the new session API."

**Agent:**
1. Picks Claude Code (user explicitly named it).
2. `which claude` — passes. `claude auth status` — passes.
3. Spawns: `claude --print "Refactor extensions/auth/ to use the new session API at packages/session/src/v2.ts. Keep tests green."` via `process_start`.
4. Polls `process_logs` every 30 seconds. Surfaces "Claude Code is editing src/auth/login.ts" to the user.
5. On exit: captures stdout/stderr, lists 7 files modified, writes `~/.ethos/delegations/auth-refactor-2026-05-06-1430/result.md`.
6. Reports: success, 7 files, 12 minutes runtime. Asks the user whether to merge.

## Troubleshooting

- **"Claude Code CLI not installed."** Install with the printed command. The skill refuses by design — better than failing opaquely mid-delegation.
- **The delegation is taking longer than expected.** Check `process_logs` for the latest output; if stuck, kill with `process_stop <id>`.
- **The delegated CLI made changes I didn't want.** Inspect the recorded session at `~/.ethos/delegations/<slug>/` and revert via git. The session record includes the exact commands and the diff.
- **`process` tool isn't available in my personality.** It's mandatory for this skill. Add `process_start`, `process_logs`, `process_stop` to the personality's `toolset.yaml`. The skill refuses to spawn without them.

## Per-CLI adapter docs

The per-CLI invocation specifics (flags, modes, defaults) live alongside the SKILL.md in the bundle:

- `extensions/skills-coding/data/coding-agent/adapters/claude-code.md`
- `extensions/skills-coding/data/coding-agent/adapters/codex.md`
- `extensions/skills-coding/data/coding-agent/adapters/opencode.md`
- `extensions/skills-coding/data/coding-agent/adapters/pi.md`

These are read by the skill at delegation time and document the flags each CLI accepts.
