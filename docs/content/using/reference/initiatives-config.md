---
title: Initiative config reference
description: Every key in an initiative file, a personality's initiatives settings.yaml and the constitution initiatives block, with defaults and edit homes.
kind: reference
audience: user
slug: initiatives-config
updated: 2026-11-28
---

Three files configure the initiative engine, and each key has one edit home. Read-only is not a key in any of them: [no setting loosens it](../explanation/initiatives.md#trade-offs).

## Source {#source}

| Part | File |
|---|---|
| Initiative file and `settings.yaml` schemas | [`extensions/initiative-runner/src/config-schema.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/initiative-runner/src/config-schema.ts) |
| Constitution block | [`packages/types/src/constitution.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/constitution.ts) (`CONSTITUTION_INITIATIVES_KEYS`) |
| Wire schemas (web) | [`packages/web-contracts/src/schema/initiatives.ts`](https://github.com/ethosagent/ethos/blob/main/packages/web-contracts/src/schema/initiatives.ts) |
| Writers | `InitiativeConfigService` (initiative files), `InitiativesService` (settings and constitution block) |

Every schema is `.strict()`: an unknown key fails the load or the save (`initiative-config.test.ts`, `initiatives-schema.test.ts`).

## Where each file is edited {#edit-homes}

| File | Path | Edit in |
|---|---|---|
| Initiative file | `~/.ethos/personalities/<id>/initiatives/<initiative-id>.yaml` | Chat only: the agent interviews you and calls `initiative_define` after your yes. The Initiatives page shows each key as a labeled row. `ethos initiatives pause` and `resume` change `state`. |
| Personality settings | `~/.ethos/personalities/<id>/initiatives/settings.yaml` | Personality editor, **Initiatives** tab. A missing file renders the defaults below. |
| Constitution block | `~/.ethos/constitution.yaml`, key `initiatives` | Settings, Automation, **Initiatives** (owner only). Limits apply at the next window; the rest of the constitution applies on restart. |

`InitiativeConfigService.save` is the only writer of initiative files. `InitiativesService` is the only writer of `settings.yaml` and the constitution block, through `Storage.writeAtomic`. A hand edit is re-validated on load. An invalid initiative file is reported with its reason on the Initiatives page, and an invalid `settings.yaml` pauses the personality (`loadInitiativeSettings`).

## Initiative file {#initiative-file}

```yaml
id: self-serve-activation
version: 3
origin: human
created_in: session-abc123
state: active
title: Self-serve activation
outcome: Raise the share of new signups reaching first value in 24h
sources: [sessions, kanban, memory, web, { repo: ~/code/app }]
exclude: [enterprise accounts]
guidance:
  - text: check LinkedIn for how competitors pitch onboarding
autonomy: { mode: free_under, ask_above_usd: 1 }
budget: { usd_per_day: 3, usd_per_exploration: 2, max_open_explorations: 3 }
timeline:
  explore_windows: ["0 9 * * 1-5", "every 6h"]
  window_minutes: 20
  default_days: 14
  review_on: "2026-12-15"
delivery: { owner_channel: "slack:C123", digest_time: "08:30" }
```

| Key | Type | Meaning |
|---|---|---|
| `id`, `title`, `outcome` | string | Identity and the result you want. Non-empty. |
| `version` | positive integer | Bumped by each save. |
| `origin` | `human` or `agent` | `agent` is saved only by the runner and needs `parent_id`. |
| `created_in` | string | The session that created it. |
| `state` | `active`, `self_started`, `paused`, `review`, `ended`, `stopped` | New human initiatives start `active`, agent ones `self_started`. |
| `sources[]` | `sessions`, `kanban`, `memory`, `web`, `slack_read`, or `{ repo: <path> }` | What a run may read. A `repo` path must be absolute or start with `~`, sit inside `readableRoots`, and avoid `~/.ssh`, `.env*`, `*.pem` and `id_*`. `slack_read` has no read tool, so it reads nothing. |
| `exclude[]` | string list | Topics to leave out. A child draft may not drop its parent's entries. |
| `guidance[]` | `{ text, maps_to?, status? }` | Advice, never permission. `status` is `mapped`, `unreachable` (no tool for it in the toolset, or no connector) or `refused` (it asks to act or reach a path). A refused line blocks the save. |
| `autonomy.mode` | `ask`, `free_under`, `free` | `ask` always waits for you. `free_under` starts a proposal at or below `ask_above_usd`. `free` never asks. |
| `autonomy.ask_above_usd` | number >= 0 | Only for `free_under`. Absent means no limit. A proposal with no estimate always waits. |
| `budget.usd_per_day` | number >= 0 | Clamped to the operator ceilings and `dailyBudgetUsd`. |
| `budget.usd_per_exploration` | number >= 0 | Budget of one exploration. Also the amount "dig deeper" adds. |
| `budget.max_open_explorations` | integer >= 0 | An automatic start needs a free slot. |
| `timeline.explore_windows[]` | cron or `every <n>h` | Recurring schedules only. A one-shot fails validation. |
| `timeline.window_minutes`, `default_days` | positive integer | Window length and the default exploration deadline. |
| `timeline.review_on`, `ends_on` | date string | Review date, and an optional end. |
| `delivery.owner_channel`, `digest_time` | string | Both are required in the file. The digest uses the personality's `settings.yaml` values. |
| `parent_id`, `notes[]` | string, list | Agent origin only. |

An agent-origin draft can never widen its parent: more sources, fewer exclusions, looser autonomy, a bigger budget, more windows per day or longer windows are refused (`initiative-draft-no-widen.test.ts`).

## Personality settings {#settings}

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | The "Takes initiatives" switch. Off removes the engine tools from this personality's chat and stops its runs. |
| `selfStart` | `false` | Lets a scan draft new initiatives. |
| `dailyBudgetUsd` | `0` | Per-personality cap. `0` means not set. Lowered on save to the smaller operator ceiling (`clampInitiativeSettings`). |
| `defaultAutonomy.mode`, `askAboveUsd` | absent | The autonomy the agent suggests during setup. |
| `delivery.ownerChannel` | absent | `<platform>:<chatId>`, for example `telegram:12345`. A bare platform is invalid. |
| `delivery.digestTime` | absent | `HH:MM` in UTC. |
| `standingGuidance[]` | `[]` | Guidance lines for every initiative of this personality. The editor shows each line's mapping. |

## Constitution block {#constitution}

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Kill switch. `false` overrides every personality at the next tick. |
| `maxUsdPerDay` | none | Ceiling across all personalities. The runner also sums the day's spend against it. |
| `maxUsdPerDayPerPersonality` | none | Ceiling for one personality, summed over its initiatives. |
| `selfStartPoolUsdPerDay` | `0.50` | Shared daily pool for agent-started initiatives. |
| `maxSelfStarted` | `2` | Open agent-started initiatives per personality. |
| `readableRoots[]` | absent | Roots a `repo` source may sit in. Absent or empty means no path source. Refuses `~/.ssh`, its children and its ancestors. |

The web save requires every key except `readableRoots`. It sends `null` for "no ceiling". Agent-started initiatives also stop after 14 days without your reaction (`AUTO_PAUSE_DAYS`).

## See also {#see-also}

- [Why is the initiative engine read-only, and what does it cost?](../explanation/initiatives.md) — the layers behind these limits.
- [Initiative budget and delivery](./initiatives-budget-and-delivery.md) — how the day budget is split and where the digest goes.
- [CLI: ethos initiatives](./cli/initiatives.md) — pause, resume and decide from a shell.
- [Initiatives RPC reference](../../building/reference/initiatives-rpc.md) — the calls the Personality and Settings controls make.
