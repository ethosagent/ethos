---
title: Watcher tools
description: "watcher_create, watcher_list, watcher_pause, watcher_resume, watcher_delete: arguments, fire budget, expiry, cooldown, per-owner cap and who may call them."
kind: reference
audience: developer
slug: watcher-tools
updated: 2026-09-29
---

Five tools let a [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) set a standing intent: "when this changes, tell me, until then". A watcher runs a deterministic differ on a schedule with no model involved, and on a change it delivers a short summary to a channel, wakes its personality, or both. Every watcher has limits, so no agent-created watcher can wake a personality without end.

## Source {#source}

| Part | File |
|---|---|
| Tools | [`extensions/tools-watchers/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-watchers/src/index.ts) (`createWatcherTools`) |
| Manager, limits and validation | [`extensions/watchers/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/watchers/src/index.ts) (`WatcherManager`, `validateWatcherInput`, `effectiveMaxFires`) |
| Wiring | `CreateAgentLoopOptions.watcherManager` in [`packages/wiring/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/index.ts) |

Tests: `extensions/watchers/src/__tests__/limits.test.ts` and `extensions/tools-watchers/src/__tests__/limits.test.ts`.

## Availability {#availability}

The tools are registered only when a `WatcherManager` is wired, which `ethos gateway start` and `ethos serve` do. `ethos chat` wires none. A personality sees them when its `toolset.yaml` lists them (toolset group `watchers`):

```yaml
# ~/.ethos/personalities/<id>/toolset.yaml
- watcher_create
- watcher_list
- watcher_pause
- watcher_resume
- watcher_delete
```

Watchers are stored in `~/.ethos/watchers/watchers.json`. Their checks ride the cron scheduler's 60-second tick as system jobs, so no second poller runs.

## Tools {#tools}

| Tool | Arguments | Needs a person-started turn | What it does |
|---|---|---|---|
| `watcher_create` | see [below](#watcher-create) | Yes | Creates a watcher owned by the calling personality. |
| `watcher_list` | none | No | Lists the calling personality's watchers with kind, target, interval, actions, remaining budget, cooldown, expiry, and why a stopped watcher stopped. |
| `watcher_pause` | `id` | No | Pauses a watcher. Its last-seen state is kept. |
| `watcher_resume` | `id` | Yes | Resumes a paused watcher. Refused when the owner is at the [per-owner cap](#limits). |
| `watcher_delete` | `id` | Yes | Deletes a watcher, its schedule and its state. |

"Needs a person-started turn" means the call is refused unless `ToolContext.initiator === 'user'`. A watcher wake, a cron turn, or any surface that does not say who started the turn gets `… needs a turn a person started`. `watcher_pause` and `watcher_list` stay open because they cannot add a fire. Enforced by `personRequired` in `extensions/tools-watchers/src/index.ts`.

## watcher_create {#watcher-create}

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Lowercase letters, digits and hyphens. Unique. |
| `kind` | `file` \| `http` \| `rss` \| `process` | yes | `file` — content hash; `http` — ETag or content; `rss` — new item GUIDs; `process` — alive or dead. |
| `target` | string | yes | A file path (`file`), a URL (`http`, `rss`), or a pid-file path, process name or PID (`process`). |
| `interval_seconds` | number | yes | Poll interval. Minimum 60. |
| `deliver` | `{ platform, chat_id }` | one of `deliver` / `wake` | Sends the change summary verbatim to that chat. No model turn. |
| `wake` | `{ personality_id, prompt_prefix? }` | one of `deliver` / `wake` | Wakes the calling personality with the summary as untrusted context. `personality_id` must be the caller. |
| `limits.expires_at` | string | no | ISO-8601 date-time **with a zone** (`Z` or `±hh:mm`), e.g. `2026-10-01T09:00:00Z`. A bare date, a zone-less time or free text is refused. After it, the watcher pauses instead of firing. |
| `limits.cooldown_seconds` | integer | no | Minimum seconds between fires, `>= 0`. A change inside the cooldown advances the watcher's state but fires nothing. |
| `limits.max_fires` | integer | no | Fires allowed before the watcher pauses. `1` to `100`; default `20`. `0` (unlimited) is refused. |

```text
watcher_create({
  id: "release-feed",
  kind: "rss",
  target: "https://github.com/ethosagent/ethos/releases.atom",
  interval_seconds: 3600,
  wake: { personality_id: "scout", prompt_prefix: "Summarise what changed." },
  limits: { expires_at: "2026-12-31T00:00:00Z", cooldown_seconds: 21600, max_fires: 10 }
})
```

`watcher_list` then shows the budget on the watcher's line:

```text
release-feed [rss] https://github.com/ethosagent/ethos/releases.atom — every 3600s, wake → scout, 10 of 10 fires left, cooldown 21600s, expires 2026-12-31T00:00:00Z (active)
```

## Limits {#limits}

| Limit | Value | Enforced by |
|---|---|---|
| Default fire budget | 20 (`DEFAULT_WATCHER_MAX_FIRES`) for a watcher with an owner | `effectiveMaxFires` |
| Largest budget an agent can set | 100 (`MAX_AGENT_WATCHER_FIRES`) | `watcher_create`, then `validateWatcherInput` |
| Active watchers per personality | 10 enabled (`MAX_WATCHERS_PER_OWNER`); paused ones do not count | `WatcherManager.createWatcher`, `WatcherManager.resumeWatcher` |
| Unlimited (`max_fires: 0`) | Only a record with no owner | `validateWatcherInput` |

Notes:

- **What counts as a fire.** A change that delivered a message or started a wake turn. A fire is reserved before the delivery runs and returned when nothing went out: a withheld delivery, no callback wired, or a wake that reports it started no turn. A delivery or wake that throws keeps the fire, because a turn may have run first.
- **Where limits are checked.** Expiry and a spent budget are checked on every tick, before the differ runs, so a watcher whose target never changes again still pauses once it expires. The cooldown and the budget are checked again when a fire is reserved. All of it is in `WatcherManager.dispatchChange`, `tick` and `claimFire`.
- **A stopped watcher.** Expiry or a spent budget pauses the watcher and records why (`stopped`), and `watcher_list` prints that reason. `watcher_resume` clears the reason but not the fires used, so a watcher with a spent budget pauses again on its next tick. Delete it and create a new one to start over.
- **Watchers with no owner.** `watcher_create` always records the calling personality as owner. A record with no owner — written before owners were recorded, or added to `watchers.json` by hand — keeps the unlimited behaviour it had before limits existed, and is the only kind that may carry `maxFires: 0`.
- **Records written before limits existed.** They load unchanged. One with an owner gets the default budget of 20.
- **Ownership.** `watcher_pause`, `watcher_resume` and `watcher_delete` act only on a watcher the calling personality owns; on a shared turn, only on one a shared turn created. Anything else returns `Watcher not found: <id>`, the same as an id that does not exist.

## Errors {#errors}

Every refusal is `code: 'input_invalid'`.

| Message (excerpt) | Cause |
|---|---|
| `watcher_create needs a turn a person started` | Called from a wake, cron or other system turn. The same for `watcher_resume` and `watcher_delete`. |
| `limits.max_fires must be at least 1` | `max_fires: 0` from an agent. |
| `limits.max_fires must be at most 100` | Budget over the agent ceiling. |
| `limits.expiresAt "…" is not an ISO-8601 date-time with a zone` | No zone, a bare date, or free text. |
| `limits.cooldownSeconds must be an integer >= 0` | A negative or fractional cooldown. |
| `personality "<id>" already has 10 active watchers` | The per-owner cap. Pause or delete one first. |
| `wake.personality_id must be the calling personality` | A watcher tried to wake a different personality. |
| `Watcher not found: <id>` | The id does not exist, or the caller does not own it. |

## Known limitations {#limitations}

- **The file lock is in-process only.** `WatcherManager.serialize` queues each read-modify-write of `watchers.json` inside one process. Two processes on one state directory (`ethos serve` beside `ethos gateway start`) can still interleave and lose an update: a fire count, a pause, a new record.
- A run that has read untrusted content cannot create a watcher with a `wake`; see [Post-read tool downgrade](../../security/controls.md#post-read-tool-downgrade).

## See also {#see-also}

- [Cron tool](cron-tools.md) — the scheduler watchers ride on, and the other way to act on a timer.
- [`outbound_policy` reference](outbound-policy.md) — when a watcher's `deliver` is refused or withheld.
- [Keep memory out of group chats](../../using/how-to/group-chat-memory.md) — why a watcher created in a group runs shared.
- [Tool interface](tool-interface.md) — the `Tool` contract these tools implement.
