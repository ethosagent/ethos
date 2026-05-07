---
title: spike
sidebar_position: 3
---

# Spike

> Throwaway exploration to validate an idea before committing to a real implementation. Time-boxed, isolated, marked as throwaway from the start.

## What it does

A spike answers a feasibility question. It is **not** a feature — the output is "yes / no / maybe with these constraints", not production code.

Spikes live under `~/.ethos/spikes/<personality>/<slug>/`. They never touch the project working directory. This is deliberate: spikes are throwaway, and putting them in the project would invite "but it works in the spike" arguments. Auto-cleanup after 14 days unless promoted.

## When the agent uses it

- The user said "let's just see if X works" / "quick experiment" / "prototype".
- The question is "is this even feasible?" rather than "how should we build this?"
- The agent self-invokes when an approach has unknown unknowns and verifying cheaply is worth a small detour.

## Prerequisites

| Requirement | How to install / configure | Verify |
|---|---|---|
| `read_file`, `write_file`, `terminal` tools | Built-in | `ethos personality show <id>` |
| `process` tool *(optional)* | Built-in (`@ethosagent/tools-process`) | Same |

## Default personalities

Enabled for: `engineer`, `coordinator`. Opt-in elsewhere.

## How it works

1. Acknowledges this is throwaway. The first line of every spike file is `# Spike: <question>`.
2. Picks the smallest scope that answers the feasibility question.
3. Writes the spike under `~/.ethos/spikes/<personality>/<slug>/`.
4. Runs / measures / reports the result.
5. Recommends one of: **keep**, **promote** (move to project), or **discard**.

## Related skills

- [`plan`](./plan) — when you already know the approach is feasible and you need to plan how to build it.

## Configuration

The 14-day auto-cleanup window is hard-coded for v1. To keep a spike, run `ethos spike promote <slug>` (planned CLI command).

## Examples

**User:** "Quick experiment — does the new API rate-limit response include a `Retry-After` header?"

**Agent:**
1. Sets up `~/.ethos/spikes/engineer/rate-limit-retry-after/`.
2. Writes a 30-line script that calls the API enough times to trigger a 429, prints the response headers.
3. Runs it. Captures the result.
4. Updates the spike's `README.md` with: "Yes — `Retry-After: 60` is present. Recommend: discard."

## Troubleshooting

- **The spike is growing past 200 lines.** Stop. The spike is becoming a proto-implementation. Write a real plan with [`plan`](./plan) and start over from scratch.
- **I want to keep the spike for reference.** Move it to a `notes/` directory in the project, or run `ethos spike promote <slug>` once that CLI command is available.
