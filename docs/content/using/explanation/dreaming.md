---
title: "What is dreaming, and why does an agent need idle time?"
description: "Dreaming is autonomous memory consolidation that runs after a quiet period — not a cron job, not a poll."
kind: explanation
audience: user
slug: dreaming
updated: 2026-05-22
---

## Context

A [personality](../../getting-started/glossary.md#personality) that has been running for weeks accumulates a MEMORY.md that drifts. Entries from two weeks ago contradict entries from yesterday. Three bullet points say the same thing in different words. A decision that was reversed still appears as current. The file is not wrong — it is stale in places, redundant in others, and nobody cleaned it up because the agent was busy doing real work.

The standard answer is "the user should edit MEMORY.md." That works, but it requires the user to notice the drift, know what to prune, and do the work. The agent is the one that wrote the entries; it is better positioned to consolidate them.

Dreaming is the feature that lets the agent do this work during idle time — after the human has stopped talking but before the next interaction begins.

## Discussion

### What dreaming is

Dreaming is a memory consolidation run triggered by idle time. After the personality has been quiet for a configurable period — no user interaction, no pending messages — the framework spawns a session that runs a built-in memory consolidation prompt (or a custom prompt supplied by the operator). The agent reviews its MEMORY.md, reorganizes entries, prunes stale items, merges duplicates, and surfaces patterns or contradictions it missed during real-time interaction. It writes the result back to MEMORY.md via the same `sync()` path that normal memory writes use.

The key property: dreaming is triggered by *absence*, not by schedule. The framework watches for idle time, not for a clock tick. If the personality is busy all day, dreaming never fires. If the personality sits idle for two hours after a morning session, dreaming fires once the idle threshold is met.

### Why it exists

Cold-start memory cost. When an agent has not been used for a while, its first [turn](../../getting-started/glossary.md#turn) requires re-reading and re-contextualizing everything in MEMORY.md. A messy MEMORY.md — redundant entries, stale facts, disorganized sections — costs more tokens to process and produces worse results because the model has to mentally sort through noise before it can focus on the user's request.

Dreaming runs during idle periods to pre-process and consolidate, so the next real interaction starts with cleaner, more organized memory. The agent returns to work with a MEMORY.md that has been reviewed, pruned, and reorganized — the equivalent of a human reviewing their notes before a meeting.

The secondary benefit is pattern recognition. During real-time interaction, the agent is focused on the current request. It does not have the bandwidth to notice that three separate sessions over the past week all ran into the same dependency issue, or that two decisions from different days contradict each other. The dream session is the time to make those connections.

### How to opt in

Dreaming is off by default. Set `dreaming.enable: true` in the personality's `config.yaml` to turn it on. The full set of fields:

| Field | Type | Default | Description |
|---|---|---|---|
| `dreaming.enable` | boolean | `false` | Master switch. No dream runs unless this is `true`. |
| `dreaming.idleMinutes` | number | `120` | How long the personality must be idle before a dream run triggers. |
| `dreaming.maxPerDay` | number | `3` | Cap on dream runs per calendar day. Prevents runaway costs if the personality has many short idle windows. |
| `dreaming.prompt` | string | *(built-in)* | Custom prompt to run instead of the built-in consolidation prompt. |

The built-in prompt instructs the agent to review MEMORY.md, remove stale entries, merge related items, resolve contradictions, and surface any patterns. It is generic and works well for most use cases. The custom prompt field exists for operators who want domain-specific consolidation logic — e.g., "also check whether any in-flight tasks have been marked done in the project tracker."

A minimal configuration:

```yaml
dreaming:
  enable: true
  idleMinutes: 120
  maxPerDay: 3
```

A configuration with a custom prompt:

```yaml
dreaming:
  enable: true
  idleMinutes: 120
  maxPerDay: 3
  prompt: "Review MEMORY.md. Remove stale entries, merge related items, and surface any patterns or contradictions."
```

### What a dream run does

A dream run is a single [turn](../../getting-started/glossary.md#turn) executed in a dedicated session. The framework:

1. Detects that the personality has been idle for `idleMinutes` with no pending messages.
2. Checks the daily dream count against `maxPerDay`. If the cap is reached, skips.
3. Spawns a new session with a distinct session key (prefixed `dream:`) so dream turns do not appear in the interactive session history.
4. Runs the consolidation prompt (built-in or custom) with the personality's current MEMORY.md loaded via `prefetch()`.
5. The agent reads, reorganizes, and writes back to MEMORY.md via the normal `sync()` path.
6. The session ends. No output is sent to any user channel.

Dream sessions use the personality's existing [toolset](../../getting-started/glossary.md#tool). The agent can read MEMORY.md, write to MEMORY.md, and use any other tool in the personality's `toolset.yaml`. It does not get extra tools and it does not lose tools — the dream session is a normal turn with a special prompt.

The distinct session key (`dream:<personality-id>:<timestamp>`) is important. Dream turns do not pollute the interactive session history. When the user opens the chat, they see their conversation, not the agent's overnight housekeeping. The dream session is visible in the audit substrate (`observability.db`) and can be inspected there, but it does not appear in the conversation thread.

### What dreaming does not do

Dreaming is not a cron job. It is triggered by idle time, not by a schedule. If the personality is actively serving users 24 hours a day, dreaming never runs. There is no "run consolidation at 3 AM" setting — the idle threshold is the only trigger.

Dreaming does not send messages to any channel. A dream run is silent. No Telegram message, no Slack notification, no CLI output. The only observable effect is a modified MEMORY.md and an audit event in `observability.db`.

Dreaming does not use a separate tool grant. The dream session uses the personality's existing toolset as declared in `toolset.yaml`. There is no dream-specific tool set and no dream-specific permission elevation.

Dreaming does not run on a separate model by default. The personality's configured `model` handles the dream turn. However, dream turns can be routed to a cheaper model via the `model.dreaming` tier — see the next section.

### The model.dreaming tier

Dream turns are memory housekeeping, not complex reasoning. They benefit from a model that is cheap and fast, not one that is deeply capable. The `model.dreaming` field in `config.yaml` lets operators route dream turns to a cheaper tier:

```yaml
model:
  default: claude-sonnet-4-6
  dreaming: claude-haiku-3
```

When `model.dreaming` is set, dream sessions use that model instead of the personality's default. This keeps costs bounded — a dream run on Haiku costs a fraction of a run on Sonnet, and the consolidation task does not require Sonnet-level reasoning.

When `model.dreaming` is not set, dream sessions use the personality's `model.default` (or `model` if the tiered syntax is not used). This is the safe default — the same model that handles interactive turns handles dream turns.

### The cost model

Each dream run is a full turn. The agent reads MEMORY.md (via `prefetch()`), processes the consolidation prompt, and writes back (via `sync()`). The token cost depends on the size of MEMORY.md and the complexity of the consolidation. For a typical MEMORY.md under the 20,000-character cap, a dream run on Haiku costs a few cents. On Sonnet, a few more.

The `maxPerDay` cap is the primary cost control. Three dream runs per day at Haiku rates is negligible. Three dream runs per day at Opus rates is noticeable. The operator picks the model tier; the cap bounds the frequency.

The secondary cost control is the idle threshold. A personality that is constantly in use never dreams. Dreaming only runs when the agent would otherwise be doing nothing — the cost is incremental to zero-activity periods, not additive to busy periods.

### When to enable dreaming

Dreaming is most valuable for personalities that:

- Accumulate long MEMORY.md files over days or weeks of use.
- Serve as long-running assistants with persistent context (project management, research, team coordination).
- Have periods of inactivity between bursts of interaction (workday patterns, timezone gaps).

Dreaming is less valuable for personalities that:

- Have short-lived sessions with no persistent memory needs.
- Already have small, well-maintained MEMORY.md files (e.g., a reviewer that clears its memory after each review cycle).
- Run in cost-sensitive environments where every token matters and the operator prefers manual memory curation.

### Observing dream activity

Dream runs are logged in `observability.db` with the session key `dream:<personality-id>:<timestamp>`. The audit events show:

- When the dream run started and ended.
- Which model handled the turn.
- How many tokens were consumed.
- Whether any memory writes occurred.

From the CLI:

```bash
ethos sessions list --prefix dream:
```

This lists all dream sessions with their timestamps and token usage. The web dashboard shows dream sessions in the Sessions view, filtered by the `dream:` prefix.

The MEMORY.md file itself is the most direct observation. If you read MEMORY.md before and after a dream run, the diff shows exactly what changed — entries removed, sections reorganized, patterns surfaced. Because MEMORY.md is a plain file, `diff` works.

## Trade-offs

**Dreaming costs tokens.** Each run is a full turn. The `maxPerDay` cap and the `model.dreaming` tier keep it bounded, but it is not free. An operator who enables dreaming on five personalities at three runs per day is paying for fifteen consolidation turns daily. On Haiku, that is cheap. On Sonnet, it adds up. On Opus, it is expensive enough to think about.

**Dream writes can surprise you.** If the agent reorganizes MEMORY.md overnight, the file looks different in the morning. This is the point — cleaner memory for the next interaction — but it can be disorienting the first time. The agent might merge two sections you mentally thought of as separate, or prune an entry you considered important but that the model judged stale. The fix is to read the diff (`git diff` if you version `~/.ethos/`) and edit the result if the agent got it wrong.

**The idle trigger is imprecise.** "Idle for 120 minutes" means no user interaction for two hours. In a team deployment where multiple users talk to the same personality, the idle window might never open. The `idleMinutes` threshold applies to the personality as a whole, not per-user. A personality that serves a globally distributed team with overlapping timezones might never dream. The operator can lower `idleMinutes`, but that risks dreaming during brief pauses in an active workday.

**Dream sessions cannot be interrupted.** Once a dream run starts, it runs to completion. If a user sends a message while the agent is dreaming, the message is queued and processed after the dream session ends. The delay is typically short (dream turns are fast, especially on Haiku), but it is nonzero. The user does not see "the agent is dreaming" — they see normal latency on their first message.

## See also

- [Why MEMORY.md and USER.md, not a vector store?](memory-model.md) — the memory model dreaming consolidates
- [Personality config reference](../reference/personality-yaml.md) — the `dreaming:` and `model:` fields in `config.yaml`
- [Why are sessions scoped per working directory?](sessions-and-history.md) — how dream sessions use distinct session keys
