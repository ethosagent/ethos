---
title: "Personality config: MCP, plugins, budget and context fields"
description: "Personality config fields for MCP, plugins, budget and context."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Fields that wire tools, budgets and the context pipeline. Part of the [Personality config reference](../personality-yaml.md).

## mcp_servers {#mcp-servers}

Type: space-separated strings · Default: unset (no MCP access)

MCP server names this personality may reach. Server configs live globally in `~/.ethos/mcp.json`; this is a per-personality allowlist. Missing or empty means no MCP access — explicit opt-in only.

```yaml
mcp_servers: github linear
```

Notes:

- Manage attachments interactively with `ethos personality mcp <id> --attach <name>` / `--detach <name>`.

## plugins {#plugins}

Type: space-separated strings · Default: unset (no plugins active)

Plugins attached to this personality. Default-deny: a plugin not listed here is dormant for this personality — its tools, hooks, and injectors do not fire.

```yaml
plugins: weather invoice-checker
```

Notes:

- Manage attachments interactively with `ethos personality plugins <id> --attach <id>` / `--detach <id>`.
- Use `ethos plugins` (plural) for the global attachment matrix.

## budgetCapUsd {#budget-cap-usd}

Type: float (USD) · Default: unset (no cap)

Per-session spending cap. When the running cost for the current session crosses this value, the next turn is refused with a typed `BUDGET_EXCEEDED` error. Session-scoped — resets on `/new` or `ethos chat` in a different working directory. Override mid-session with [`/budget reset`](../slash-commands.md#slash-budget).

```yaml
budgetCapUsd: 1.00
```

## context_engine {#context-engine}

Type: string · Default: `drop_oldest`

Context-compaction engine name. Resolved against the runtime's engine registry when the conversation approaches the model's context window. Unknown names fall back to the built-in `drop_oldest`.

```yaml
context_engine: summarize_oldest
```

## context_engine_options.\* {#context-engine-options}

Type: scalar (string / number / boolean) · Default: unset

Free-form per-engine options. Keys are dotted (`context_engine_options.<key>`); values are typed automatically — integers, floats, `true` / `false`, otherwise strings.

```yaml
context_engine_options.keep_last_n: 8
context_engine_options.summary_model: claude-haiku-4-5
```

## context_layering.* {#context-layering}

Workspace-aware context layering. Controls how `AGENTS.md` / `CLAUDE.md` files are discovered as the agent navigates the workspace.

| Field | Type | Default | Description |
|---|---|---|---|
| `context_layering.mode` | `static` \| `progressive` \| `off` | `static` | `static` loads context once at session start from `workingDir`. `progressive` also discovers sub-`AGENTS.md` as the agent reads / writes files; injected on the next turn. `off` skips context-file injection entirely. |
| `context_layering.max_depth` | integer | runtime default | Maximum directory depth to walk when discovering context files. |
| `context_layering.discovery_files` | comma-separated strings | `AGENTS.md, CLAUDE.md` | Filenames to scan for at each depth. |
| `context_layering.cap_total_chars` | integer | runtime default | Cap on the total character budget injected. |

```yaml
context_layering.mode: progressive
context_layering.max_depth: 3
context_layering.discovery_files: AGENTS.md, CLAUDE.md, SOUL.md
context_layering.cap_total_chars: 12000
```

## skill_evolution.* {#skill-evolution}

Per-personality skill learning: whether this personality drafts skill candidates, and where and how a drafted skill may go live. Every draft becomes a candidate in the [learning inbox](../../explanation/learning-inbox.md); no key here writes a live skill file. The built-in `engineer` personality sets `enabled: true`, `min_tool_calls: 5` and `cooldown_minutes: 60`.

Source: `skill_evolution` on `PersonalityConfig` in [`packages/types/src/personality.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/personality.ts), parsed by `buildSkillEvolution` in [`extensions/personalities/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/personalities/src/index.ts).

| Field | Type | Default | Description |
|---|---|---|---|
| `skill_evolution.enabled` | boolean | `false` | Turns on this personality's two automatic drafters: the post-turn improvement fork (`ImprovementFork.shouldFork`, `extensions/skill-evolver/src/improvement-fork.ts`) and the nightly pass's skill drafter (`nightlySkillDrafter`, `apps/ethos/src/commands/nightly.ts`). Unset or `false` = neither runs, and neither makes an LLM call. Does not gate `ethos evolve` or `ethos eval --evolve`, which draft whenever they are run. |
| `skill_evolution.min_tool_calls` | integer | `5` | Successful tool calls a turn needs before the fork runs (`ImprovementFork.shouldFork`). A turn with fewer does not fork. Fork only. |
| `skill_evolution.cooldown_minutes` | integer | `60` | Minimum minutes between fork runs for this personality, counted from the start of the previous run whether or not it drafted anything. Held in memory per process, so a restart clears it. Fork only. |
| `skill_evolution.model` | string | unset | Model id this personality's skill drafting runs on, sent as `modelOverride` to the configured provider: the fork's turn, the nightly skill drafter, and `ethos evolve` / `ethos eval --evolve` for the configured default personality (`skillEvolutionEvolveOptions`, `extensions/skill-evolver/src/evolver.ts`). Must be a model that provider serves; it does not switch provider. Unset = the provider's own model. |
| `skill_evolution.evolve_existing` | boolean | unset | `false` stops rewrites of existing skills while new skills still draft. `ethos evolve` and `ethos eval --evolve` skip the rewrite branch (`evolveExisting` on `SkillEvolver`), and the fork's `skill_propose` refuses a `targetFile`. The nightly drafter only drafts new skills, so the key does not change it. Unset or `true` = rewrites are drafted. |
| `skill_evolution.promotion` | `review` \| `auto` | unset | Whether this personality's skill candidates may promote without a human. Values below. |
| `skill_evolution.scope` | `shared` \| `personality` | `shared` | Where a promoted skill is written (`liveSkillDir`, `extensions/skill-evolver/src/skill-dir.ts`). Values below. |

`skill_evolution.promotion` values, resolved by `resolveAutoPromotion` in `extensions/learning-inbox/src/auto-promotion.ts`:

- `auto` — a candidate whose replay verdict is `pass` promotes without a human, provided `scope` is `personality`.
- `review` — every candidate waits for a human, whatever `evolution_approval_mode` or `autoApprove` say.
- unset (default) — falls back to `evolution_approval_mode` (`auto` → auto, `user` → review), then to `autoApprove` in `~/.ethos/evolve-config.json`, then review.

`skill_evolution.scope` values:

- `shared` (default) — `~/.ethos/skills/`, loaded by every personality whose toolset covers the skill's required tools. A shared skill always needs a human to promote, even after a `pass` (`autoPromotionDecision`).
- `personality` — `~/.ethos/personalities/<id>/skills/`, loaded by this personality only. The only skill destination auto-promotion writes to.

```yaml
skill_evolution.enabled: true
skill_evolution.min_tool_calls: 5
skill_evolution.cooldown_minutes: 60
skill_evolution.evolve_existing: false
skill_evolution.promotion: auto
skill_evolution.scope: personality
```

Notes:

- Nothing here skips replay. A skill candidate goes live only on a `pass` replay that the rules above allow, or on a human approval; approving anything that is not a `pass` needs a reason, recorded in the audit log. Replay measures approach, not answers that depend on real tool output. See [Why does a learned change need a replay before it goes live?](../../explanation/learning-inbox.md).
- `promotion` and `scope` are read when a candidate is replayed or promoted, not when it is drafted (`learningPolicyFor`, `packages/wiring/src/learning-pipeline.ts`; `promote`, `extensions/learning-inbox/src/promote.ts`). A candidate drafted against the other scope becomes `stale` instead of promoting.
- An unrecognised `promotion` or `scope` value, or a non-integer `min_tool_calls` or `cooldown_minutes`, is ignored as if unset.
- `evolve_existing` and `model` are read when a draft is made, not when it is replayed. The chat-turn `skill_propose` tool (`packages/wiring/src/compose-tools.ts`) reads neither, so a rewrite proposed from a chat turn is still submitted.
- The global evolver schedule lives in [`config.yaml`](../config-yaml.md#evolver-cron-enabled) (`evolver.cron_enabled`, `evolver.schedule`), not here.

## See also {#see-also}

- [Personality config reference](../personality-yaml.md): the index of every section and its page.
