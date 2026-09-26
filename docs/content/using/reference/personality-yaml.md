---
title: "Personality config reference"
description: "Every field in a personality's config.yaml and toolset.yaml — model, fs_reach, MCP, plugins, budget, voice, safety."
kind: reference
audience: user
slug: personality-yaml
updated: 2026-09-25
---

A [personality](../../getting-started/glossary.md#personality) is a directory at `~/.ethos/personalities/<id>/` with three files:

| File | Purpose |
|---|---|
| `SOUL.md` | First-person identity prose. Loaded as the system-prompt baseline. Free-form markdown. |
| `config.yaml` | Flat `key: value` config — fields documented below. Dotted keys (e.g. `fs_reach.read`) express nested structure. |
| `toolset.yaml` | Flat YAML list of [tool](../../getting-started/glossary.md#tool) names this personality is allowed to call. |

An optional sibling file `tools.yaml` configures a tool per personality. It is **not** a field on the frozen `PersonalityConfig` schema (like `mcp.yaml`, it is a sibling artifact loaded by the registry), so it does not touch `.personality-field-count`. Four tools are configurable, each binding a **named secret**:

```yaml
# ~/.ethos/personalities/researcher/tools.yaml
web_search: { provider: exa, secret: exa-main, recency: 30d }
x_search: { secret: xai-main }
engine_ask: { secret: openai-brand }
youtube: { secret: yt-main }
```

`web_search` binds a provider, a named secret, and an optional `recency` default (documented below). `x_search` binds an xAI named secret (`providers/xai/<name>`). `engine_ask` binds an OpenAI named secret (`providers/openai/<name>` — the same namespace the OpenAI model provider uses; absent, it falls back to `providers/openai/apiKey`) that covers the ChatGPT engine only. `engine_ask` called with `engine: perplexity` reads one operator-wide key at the vault ref `providers/perplexity/apiKey`, set in Settings > Keys or from the environment variable `PERPLEXITY_API_KEY`; it cannot be bound per personality. `youtube` binds a Google named secret (`providers/google/<name>`) shared by `youtube_search` and `youtube_comments` — the same API key, the same daily quota; absent, it falls back to `providers/google/apiKey`.

`secret` is a NAME only (resolving to `providers/<provider>/<name>` in the vault) — never a value — so the directory stays shareable and committable ([§V S9](https://github.com/ethosagent/ethos/blob/main/ARCHITECTURE.md)). The personality's own `tools.yaml` is the source of truth; the global `~/.ethos/config.yaml` `toolSettings` map is a fallback layer for personalities (especially read-only built-ins) that don't declare the tool. Resolution order: `tools.yaml` → `toolSettings.<id>` → `toolSettings._default` → the tool's default key.

`quora_search`, `linkedin_search`, and `reddit_web_search` are listed in [`toolset.yaml`](#toolset-yaml) like any other tool, but take no key here — they read the `web_search` binding above instead of one of their own. A personality that binds `web_search` gets Quora, LinkedIn, and Reddit search under the same credential for free; binding a `quora_search:`, `linkedin_search:`, or `reddit_web_search:` key in `tools.yaml` has no effect, because nothing reads it.

All three, and `web_search` itself, render a hit's publication date as ISO `YYYY-MM-DD` at the end of its heading line when the backend supplied one, and render no date at all when it did not — a missing date is never defaulted, guessed, or filled with today's. All four also accept an optional `max_age` argument: a duration written `<number><d|w|m|y>` — `30d`, `2w`, `6m`, `1y`. The grammar is calendar-naive (`d` is 1 day, `w` 7, `m` 30, `y` 365), so the same argument means the same window on every date. `parseMaxAge` in [`extensions/tools-web/src/max-age.ts`](../../../../extensions/tools-web/src/max-age.ts) is the only parser: it trims and lowercases, and rejects a quantity below 1. Each of the four tools turns a rejected argument into an `input_invalid` error rather than searching unfiltered — a dropped filter would return unfiltered results to a caller who believes one is on.

The window is requested upstream in whatever form the chosen backend accepts, mapped in [`extensions/tools-web/src/search-backends.ts`](../../../../extensions/tools-web/src/search-backends.ts):

| Backend | Parameter sent | Exact? |
|---|---|---|
| Exa | `startPublishedDate`, an ISO 8601 instant | Yes — expresses any duration. |
| Tavily | `start_date`, a `YYYY-MM-DD` floor | Yes, to the day. Tavily matches publish date **or** last-updated date, so a stale page edited yesterday can match a short window. |
| Brave | `freshness` as a `YYYY-MM-DDtoYYYY-MM-DD` range | Yes, to the day. The `pd`/`pw`/`pm`/`py` buckets are not used — they could only approximate. |
| SearXNG | `time_range`, buckets `day` / `month` / `year` only | No. Widened to the smallest bucket containing the window, never narrowed; past a year no `time_range` is sent at all. |

SearXNG is the only approximation, and it is disclosed rather than silent: `recencyLimitationNote` (same file) prints a `Note:` line in the rendered output for both inexact cases. Its accuracy is bounded further by a limitation Ethos cannot check — `time_range` support in SearXNG varies with the engines an instance enables, so the bucket is sent but the upstream is not verified to have honoured it.

Whichever backend answered, the window is enforced locally by `filterByMaxAge` (`max-age.ts`), which drops every hit whose publication date reads as outside it. **Hits carrying no readable date pass through.** That is a deliberate limitation: Brave's `page_age` and SearXNG's `publishedDate` are frequently absent, and dropping undated hits would empty the result set exactly where the upstream filter is weakest. A `max_age` result means "nothing dated outside the window", not "everything here is inside it".

The window also takes a persistent default: `recency` on the `web_search` binding, or `toolSettings.<id>.web_search.recency` in `~/.ethos/config.yaml`, written in the same grammar and read by the same `parseMaxAge`. All four tools honour it — the three site tools resolve it from the shared `web_search` binding through their own `resolveSetting`, down the chain they already used for `provider` and `secret`: `tools.yaml` → `toolSettings.<id>` → `toolSettings._default`. Precedence is uniform: call argument `max_age` → bound `recency` → no filter. A stored value that fails the grammar is **ignored**, falling through to no filter — asymmetric with the call argument on purpose, since refusing a bad setting made once elsewhere would break every search the personality runs.

A hand-written `recency` is normalized before it is stored, so `recency: 30D` in `tools.yaml` persists as `30d` rather than being dropped without a word — `normalizeRecency` in [`extensions/personalities/src/index.ts`](../../../../extensions/personalities/src/index.ts) and its twin `normalizeWebSearchRecency` in [`packages/config/src/index.ts`](../../../../packages/config/src/index.ts). Only `web_search` carries a Settings UI control for the key: a closed dropdown (`7d`, `30d`, `90d`, `6m`, `1y`) that clears back to no filter, from the `settingsSchema` on the tool in [`extensions/tools-web/src/index.ts`](../../../../extensions/tools-web/src/index.ts). `quora_search`, `linkedin_search`, and `reddit_web_search` declare no `settingsSchema` of their own, so they are configured through `web_search`'s binding rather than one of theirs; the open grammar stays available to the per-call argument on all four.

`reddit_web_search` is the credential-free route to Reddit: it searches through the `web_search` backend constrained to `reddit.com` and returns post titles, subreddits, URLs, snippets, and whatever publication date the search index recorded — no scores, no comment counts. `reddit_search` and `reddit_thread` speak Reddit's official API instead, which buys engagement counts, subreddit scoping, and a per-post timestamp on every result rather than only on the ones a search index happened to date; they need a Reddit `client_id`/`client_secret` pair bound under Settings > Named Secrets, not a `tools.yaml` key.

## Source {#source}

The schema type lives in [`packages/types/src/personality.ts`](../../../../packages/types/src/personality.ts) (`PersonalityConfig`). The loader / parser lives in [`extensions/personalities/src/index.ts`](../../../../extensions/personalities/src/index.ts) — `parseConfigYaml` (flat keys + the `safety:` nested block), `parseToolsetYaml` (the `- name` list), and `parseToolsYaml` (the optional `tools.yaml` sidecar).

The schema is frozen — adding a top-level field requires the `personality-schema-change` PR label and a bump to `.personality-field-count`. Internal-only fields (`id`, `soulFile`, `skillsDirs`, `metadata`) are populated by the loader and are not user-editable.

## Minimal example {#minimal-example}

```yaml
# ~/.ethos/personalities/researcher/config.yaml
name: Researcher
description: Deep reading and synthesis.
```

```yaml
# ~/.ethos/personalities/researcher/toolset.yaml
- read_file
- write_file
- web_search
```

Memory is always per-personality — each personality reads and writes `~/.ethos/personalities/<id>/MEMORY.md` automatically. No configuration field is required.

## name {#name}

Type: string · Default: title-cased directory id · Required

Human-readable label. Surfaces in `ethos personality list`, the picker UIs, and the chat header.

```yaml
name: Engineer Paired
```

## description {#description}

Type: string · Default: unset

One-line summary shown in pickers and `ethos personality list`.

```yaml
description: Builds and ships features for this repo.
```

## model {#model}

Type: string, or dotted role keys · Default: the deployment's `model` in `~/.ethos/config.yaml`. A declaration names a **role** (`trivial`, `default`, `deep`, `dreaming`) or an **alias** the operator defined under `modelRegistry.*` in `~/.ethos/config.yaml`. A vendor model id is neither and does not parse (`parseModelDeclaration`, [`packages/core/src/model-resolution.ts`](../../../../packages/core/src/model-resolution.ts)). `resolveTurnModel` ([`packages/core/src/agent-loop/turn-model.ts`](../../../../packages/core/src/agent-loop/turn-model.ts)) picks each turn's model:

- **With a model registry**, the first rung that declares wins: a `/model` pin for the run, a team manifest entry, [`modelRouting.<id>`](./config-yaml.md#model-routing), this `model`, `modelRegistry.roles.<role>`, then `modelRegistry.default`. A declaration that does not resolve refuses the turn with `model_unresolved` instead of running on something else.
- **Without one** — every deployment today, because the wiring hands the loop an empty registry (`modelResolution` in `packages/wiring/src/build-agent-loop.ts`) — a `/model` pin, then `modelRouting.<id>`, then the deployment's `model`. This `model` is not read and `provider` is not compared; `ethos personality show <id>` marks it inert (`resolveCharacterSheetRouting`, `packages/wiring/src/tier-diagnostics.ts`). To pin one model today, use `modelRouting.<id>`.

| Key | Used for |
|---|---|
| `model.default` | Turns that request no other role, and the fallback for any role left unset. |
| `model.trivial`, `model.deep`, `model.dreaming` | Turns that request that role: `/tier trivial`, `/tier deep`, a `think_deeper` escalation, or a dreaming run (`extensions/gateway/src/dream-executor.ts`). |

```yaml
model.default: sonnet   # aliases defined under modelRegistry.*
model.deep: opus
```

## provider {#provider}

Type: string · Default: top-level `config.yaml` `provider`

Per-personality provider override. Only meaningful when the wiring layer has the named provider registered.

```yaml
provider: openrouter
```

## platform {#platform}

Type: string · Default: unset

Channel binding hint. Recognised values (used by the load-time safety gate): `telegram`, `discord`, `slack`, `whatsapp`, `email`. Bound channels combined with `safety.approvalMode: off` are rejected at config load.

```yaml
platform: slack
```

## capabilities {#capabilities}

Type: comma-separated strings · Default: unset

Free-form capability tags. Surfaces to skill-filtering and adapter routing.

```yaml
capabilities: read, write, web
```

## streamingTimeoutMs {#streaming-timeout-ms}

Type: integer (ms) · Default: `1200000` (20 minutes) — `DEFAULT_STREAMING_TIMEOUT_MS` in [packages/core/src/agent-loop/streaming-timeout.ts](../../../../packages/core/src/agent-loop/streaming-timeout.ts)

Watchdog for the LLM stream. If no chunk arrives within this many milliseconds, the agent aborts the stream and emits an `error` event with code `streaming_timeout`. Reset on every chunk — a slow-but-progressing stream of any total duration is unaffected, so this bounds silence, not length. Thinking-mode personalities (Opus extended thinking) inherit the 20-minute default; fast personalities (Haiku) can pick tighter to surface a wedged provider sooner.

A deployment-wide override goes in `~/.ethos/config.yaml`; this key overrides both, per personality.

```yaml
streamingTimeoutMs: 60000
```

## execution {#execution}

Type: string · Default: unset (the deployment decides)

Execution requirement — what this personality demands of wherever its execution tools (`terminal`, `run_code`, `run_tests`, `lint`) run. Two values:

- `remote` — this personality's work belongs on a machine that is **not** the one Ethos runs on. Refused under a constitution that sets `execution.requireSandbox` or `execution.forbidLocal`: a remote host is trust, not confinement.
- `none` — this personality does not execute.

```yaml
execution: remote
```

A personality states a requirement; it never names a transport. `docker`, `local` and `ssh` are machine facts two deployments of the same personality reasonably disagree about — one runs inside a container, one has no Docker daemon, one has an ssh target — so the transport is the operator's, resolved from the environment, [`~/.ethos/config.yaml`](./config-yaml.md), and the constitution. Absent means no requirement at all: an exec-bearing personality is sandboxed by default, and runs in-process when Ethos is itself containerized.

- This is **not** the remote host. The target — host, user, port, identity file, known-hosts file, remote workdir — is operator config under `execution.ssh.*` in [`~/.ethos/config.yaml`](./config-yaml.md), one per deployment. Never put a hostname, user, or key path in this file.
- **A requirement this deployment cannot meet is refused, not downgraded.** `execution: remote` with no `execution.ssh.host` configured leaves the execution tools unavailable. It does not fall back to running the work here, whatever the constitution permits — a permitting constitution grants the host, which is the one machine this personality ruled out.
- `ethos personality show <id>` prints the requirement and the resolved transport on separate lines, so you can see both what was asked for and what you got.
- An unrecognised value is a load error, not a silent drop. So are the retired transport literals `ssh`, `docker` and `local`; the error names the replacement.
- **When an edit takes effect depends on which personality you edited.** For any personality other than the one the process was started with, the requirement is re-resolved on every turn against the hot-reloaded registry — edit the file, send a message, done. For the process's *default* personality it is resolved once, eagerly, at composition, so that one needs a restart. The eager resolution is deliberate: it makes an unreachable ssh target or an unbuildable sandbox a loud startup failure rather than a surprise mid-turn.

## fs_reach.read / fs_reach.write {#fs-reach}

Type: comma-separated absolute paths · Default: AgentLoop fallback scope

Per-personality filesystem allowlist for the `read_file` / `write_file` tools. The runtime resolves these substitutions once per turn:

| Token | Resolves to |
|---|---|
| `${ETHOS_HOME}` | `~/.ethos` |
| `${self}` | This personality's id. |
| `${CWD}` | The personality's working directory — the **first** [`fs_reach.workdir`](#fs-reach-workdir) entry when declared, otherwise the process working directory. |

When unset, the fallback is:

```
read:  [~/.ethos/personalities/<self>/, ~/.ethos/skills/, ${CWD}]
write: [~/.ethos/personalities/<self>/, ${CWD}]
```

A declared list replaces the defaults for that direction — it is not merged with them. Paths outside the allowlist surface as a `BoundaryError` from `ScopedStorage` and are rendered as a user-facing tool error.

```yaml
fs_reach.read: ${CWD}, ${ETHOS_HOME}/skills, ${ETHOS_HOME}/personalities/${self}
fs_reach.write: ${CWD}, ${ETHOS_HOME}/personalities/${self}
```

Notes:

- Under the container execution posture, the derived read and write paths are the container's bind mounts (read-only and read-write respectively), so the app-layer allowlist and the OS-layer mount set never disagree.
- The active personality's derived write paths are created at startup if missing. Read-only paths are not — a read prefix that does not exist is simply an empty scope.
- Paths under `/proc`, `/sys`, `/dev`, or a Docker socket are never mounted into a container and are never pre-created.

## fs_reach.workdir {#fs-reach-workdir}

Type: one or more comma-separated absolute paths · Default: unset (the process working directory)

The personality's working directory. Each entry takes the same substitution tokens as `fs_reach.read` / `fs_reach.write` and resolves to an absolute path. The **first** entry is the personality's working directory and becomes `${CWD}` for the rest of the `fs_reach` derivation: every tool in the personality's toolset stands there, a bare relative path passed to `read_file` or `write_file` resolves against it, and the `terminal` tool runs its commands in it under both the local and the container execution posture.

```yaml
fs_reach.workdir: ${ETHOS_HOME}/workspace/${self}
```

Declare several to give the [Documents tab](../how-to/retrieve-agent-files.md) several roots. Each entry becomes its own browsable root with its own containment boundary:

```yaml
fs_reach.workdir: ${ETHOS_HOME}/workspace/${self}, /srv/reports
```

Notes:

- The first declared entry is added to both the derived read list and the derived write list, so it stays reachable even when `fs_reach.write` is declared and therefore replaces the defaults. Later entries are **not** — a second root is browsable from Documents but out of the agent's own reach until it is listed in `fs_reach.read` / `fs_reach.write` too.
- The dotted key is the only accepted syntax — an indented `fs_reach:` block is refused at load with `Top-level key "fs_reach" cannot be a nested object in personality config`.
- A token that resolves to an empty string refuses the turn with `FS_REACH_INVALID` rather than synthesizing a path at the filesystem root.
- Unset leaves the derivation untouched: the working directory is the process working directory and the read/write lists derive exactly as they did before this field existed. The Documents tab, which has no such fallback, shows the personality as unconfigured — see [`WORKDIR_NOT_CONFIGURED`](../../troubleshooting.md#error-reference).
- `ethos personality show <id>` prints the declared value (tokens unresolved) as a `Workdir` line under **Filesystem reach**.
- Files written here are retrievable from a browser — see [Retrieve files the agent wrote](../how-to/retrieve-agent-files.md). Files can be uploaded into the same directory — see [Upload a file into the agent's folder](../how-to/upload-agent-files.md).

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

Per-session spending cap. When the running cost for the current session crosses this value, the next turn is refused with a typed `BUDGET_EXCEEDED` error. Session-scoped — resets on `/new` or `ethos chat` in a different working directory. Override mid-session with [`/budget reset`](./slash-commands.md#slash-budget).

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

Per-personality skill learning: whether this personality drafts skill candidates, and where and how a drafted skill may go live. Every draft becomes a candidate in the [learning inbox](../explanation/learning-inbox.md); no key here writes a live skill file. The built-in `engineer` personality sets `enabled: true`, `min_tool_calls: 5` and `cooldown_minutes: 60`.

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

- Nothing here skips replay. A skill candidate goes live only on a `pass` replay that the rules above allow, or on a human approval; approving anything that is not a `pass` needs a reason, recorded in the audit log. Replay measures approach, not answers that depend on real tool output. See [Why does a learned change need a replay before it goes live?](../explanation/learning-inbox.md).
- `promotion` and `scope` are read when a candidate is replayed or promoted, not when it is drafted (`learningPolicyFor`, `packages/wiring/src/learning-pipeline.ts`; `promote`, `extensions/learning-inbox/src/promote.ts`). A candidate drafted against the other scope becomes `stale` instead of promoting.
- An unrecognised `promotion` or `scope` value, or a non-integer `min_tool_calls` or `cooldown_minutes`, is ignored as if unset.
- `evolve_existing` and `model` are read when a draft is made, not when it is replayed. The chat-turn `skill_propose` tool (`packages/wiring/src/compose-tools.ts`) reads neither, so a rewrite proposed from a chat turn is still submitted.
- The global evolver schedule lives in [`config.yaml`](./config-yaml.md#evolver-cron-enabled) (`evolver.cron_enabled`, `evolver.schedule`), not here.

## safety {#safety}

Per-personality safety config. Unlike the other fields, `safety:` is a true nested block — YAML indentation matters here.

```yaml
safety:
  approvalMode: manual
  observability:
    storeToolArgs: redacted
    storeLlmPayloads: metadata
    redactPatterns:
      - sk-ant-
      - sk-or-
```

### safety.approvalMode {#safety-approval-mode}

Type: `manual` | `smart` | `off` · Default: `manual`

Decides what happens when a tool call is classified `dangerous`.

| Value | Behaviour |
|---|---|
| `manual` | Every `dangerous` classification surfaces the approval prompt (the web UI modal, or a Slack / Telegram / Discord card); `safe` auto-fires; `blocked` errors out. `ethos chat` asks in the terminal (a `y/N` line in the readline REPL, a modal in the TUI). Where nobody can answer — `ethos chat -q`, piped stdin, `ethos -z`, `batch`, `eval`, `cron`, `bench`, `ethos mcp serve`, `ethos acp` — the call is refused (`wireTerminalApprovalGate`, `apps/ethos/src/terminal-approval.ts`). See [Set up approval gates](../how-to/set-up-approval-gates.md). |
| `smart` | An auxiliary fast-model call reviews each `dangerous` classification and either auto-approves, auto-denies, or escalates to `manual`. Trades latency and dollars for reduced approval fatigue. |
| `off` | `dangerous` classifications auto-fire without prompting; the hardline `blocked` floor still applies. Honoured only on unattended cron — the gateway's cron/dream loop and `ethos cron run` / `ethos cron daemon` — with `allowUnattendedDangerousTools: true`, and in `ethos chat` and the other operator-invoked CLI commands. A command using `$(…)` or backticks is never auto-approved: the CLI asks about it and unattended cron refuses it; everywhere else `off` behaves like `manual`. |

Notes:

- `approvalMode: off` paired with any channel ingress (`platform: telegram / discord / slack / whatsapp / email`) is rejected at config load.

### safety.observability.* {#safety-observability}

Controls what the observability store persists for this personality.

| Field | Values | Description |
|---|---|---|
| `safety.observability.storeToolArgs` | `none` \| `redacted` \| `full` | Tool-call arguments. |
| `safety.observability.storeToolBodies` | `none` \| `redacted` \| `full` | Reserved. Accepted and validated, but tool-call result bodies are never stored at any setting; only the result size is recorded. |
| `safety.observability.storeLlmPayloads` | `none` \| `metadata` \| `full` | LLM request and response payloads. |
| `safety.observability.redactPatterns` | string[] | Substrings redacted from anything stored. |

## voice.\* {#voice}

Type: dotted block · Default: unset (inherit the deployment's voice config)

How this personality sounds, which engines serve it, and how its call is drawn. A deployment picks the *provider*; the personality picks how it *sounds* and how it *looks*, so anything declared here beats the global [`auxiliary.tts.*` / `voice.*`](./config-yaml.md#voice-tier) and `display.call_style` settings, and silence means inherit. The provider, voice and call-look keys are editable in the web Personalities tab (Identity step); `tier`, `model` and the language map are file-only.

| Field | Type | Description |
|---|---|---|
| `voice.tts_voice` | string | Voice id handed to the TTS provider. Provider-specific and free-form — `af_bella` for Kokoro, `alloy` for OpenAI. |
| `voice.languages.<tag>` | string | BCP-47 tag → voice id. Beats `tts_voice` when the turn's language is known. Two surfaces supply one: browser talk-mode reports the language it heard, and the gateway derives it from an inbound voice note's transcript with `detectLanguage()` (`@ethosagent/voice-text`). Detection is constrained to the tags declared here and to nothing else — a personality with no language map supplies no candidates, so no guess is made and `tts_voice` wins. |
| `voice.tier` | `pipeline` \| `realtime` | Preferred voice engine, beating the deployment's [`voice.tier`](./config-yaml.md#voice-tier). A preference, not a guarantee: a deployment with no realtime provider serves `pipeline` either way. An unrecognised value is dropped rather than thrown on — a bad voice field must not make a personality unloadable. |
| `voice.tts_provider` | string | Names an entry in the deployment's TTS roster (`voice.tts.providers.<name>`). A **label** the operator chose, never a provider id. A name this machine lacks falls back to the default `auxiliary.tts` entry, so a shared personality still speaks. |
| `voice.stt_provider` | string | The same, for the STT roster. A personality's voice is identity; its ear is a technical override. |
| `voice.realtime_provider` | string | The same, for the [realtime roster](./config-yaml.md#voice-realtime-providers). Consulted only on the realtime tier; falls back to `voice.realtime.default`. |
| `voice.model` | string | Fast-lane model for spoken turns — a small, quick model for conversation, so a voice lane never waits on the agentic default. Pinned onto the lane's runner once when the session opens, not per turn, so every host that opens a voice lane (the LiveKit adapter, the SIP adapter) gets the routing without having to remember it. Resolves from the personality alone: the deployment's `model` is deliberately not a fallback, since handing it over would pin every spoken lane to the model this key exists to keep off it. Unset leaves the runner untouched. |
| `voice.call_style` | `liquid` \| `orb` \| `rings` | Which treatment the Call Stage draws for this personality — `liquid`, the circle filling like a vessel; `orb`, a body deforming with the voice; `rings`, concentric rings breathing outward. Unset is **not** a fixed default: the treatment falls through to the operator's `display.call_style` when that names a concrete shape, and otherwise to one derived from the personality id, so every personality already looks distinct. An unrecognised value is dropped rather than thrown on. |

```yaml
voice.tts_voice: af_bella
voice.languages.es: ef_dora
voice.tier: realtime
voice.realtime_provider: live
voice.call_style: rings
```

Notes:

- Voice-id precedence, resolved in one function (`resolveVoicePreferences`) so every surface agrees: `voice.languages.<tag>` > `voice.tts_voice` > the chosen entry's own `voice` > global `auxiliary.tts.voice`. A realtime call uses the same order, so switching tiers does not switch who you are talking to.
- Naming a roster entry buys no trust. The [egress gate](./config-yaml.md#voice-trusted-plugins) keys on the entry's underlying `provider`, so an entry called `local-anything` backed by a hosted model is still refused.
- `voice.provider` is accepted on read as the older spelling of `voice.tts_provider` and re-serialized as the new one; a file never carries both.
- Talk-mode also needs `voice_session` in [`toolset.yaml`](#toolset-yaml). Without it the phone button renders disabled.
- Call-look precedence, resolved in one function (`resolveCallTreatment` in `packages/types/src/personality.ts`) so every surface agrees: `voice.call_style` > a concrete `display.call_style` > derived from the personality id. `display.call_style: personality` is the default and is not a pin — it defers to the derivation.
- Confirm what parsed with `ethos personality show <id>` — it emits a `## Voice` block, and omits the section entirely when the personality declares no `voice` block. Its `Call look` line names the derived treatment when the key is unset, because there is no blank state to report.

## mcp_export.\* {#mcp-export}

Type: dotted block · Default: unset (not exported). Lets `ethos mcp serve --personality <id>` export this personality as one `ask` tool — walkthrough in [Use Ethos as an MCP server](../how-to/use-as-mcp-server.md). Parsed by `buildMcpExportConfig` in [`extensions/personalities/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/personalities/src/index.ts). A value outside a key's vocabulary is ignored and the fail-closed default stands — `expose_memory: Scoped` resolves to `none`.

| Field | Default | Description |
|---|---|---|
| `mcp_export.enabled` | absent — no export | Must be the literal `true`. `yes`, `True` and `1` parse as `false` (`buildMcpExportConfig` compares `=== 'true'`). |
| `mcp_export.expose_tools` | `none` | Tools the exported **turn** may use — never published to the caller. `all` is this personality's full reach; a whitespace-separated list is intersected with it, and a name outside it is dropped, not granted. |
| `mcp_export.expose_memory` | `none` | `none` skips the memory prefetch and both memory tools; `scoped` adds read-only `personality:<id>`; `full` adds `memory_write`. |
| `mcp_export.expose_sessions` | `false` | `true` adds `list_conversations` and `get_conversation`, over the calling client's own conversations only. |
| `mcp_export.auth` | `localhost` | `localhost` is stdio only. `bearer` requires an `sk-ethos-` key scoped `mcp:<id>`, and is the only value that can serve HTTP. |

## outbound_policy.\* {#outbound-policy}

Type: dotted block · Default: unset (the agent's `send_message` publishes as soon as it calls it)

Queue this personality's agent-initiated posts for human approval instead of sending them. Full semantics — the lifecycle, the content binding, the refusal codes and what the gate does not cover — are in the [`outbound_policy` reference](../../building/reference/outbound-policy.md).

| Field | Type | Description |
|---|---|---|
| `outbound_policy.approve_before_send` | boolean | Only the literal `true` switches the gate on (`buildOutboundPolicy` compares `approve === 'true'`). When the key is absent the whole block is skipped and the other two are neither parsed nor validated. |
| `outbound_policy.channels` | whitespace-separated names | Which platforms are gated: `slack`, `telegram`, `discord`, `whatsapp`, `email`. Absent — or an empty list — gates every platform. An unknown name fails the personality load with `Invalid outbound_policy.channels: "<name>"`, so a typo cannot silently leave a platform ungated. |
| `outbound_policy.approver_personality` | personality id | An advisory reviewer that reads the draft and attaches a PASS/FAIL receipt before a human sees it. It can neither approve nor block. An id this machine does not have yields an `unavailable` receipt and the item still reaches the human. |

```yaml
outbound_policy.approve_before_send: true
outbound_policy.channels: telegram slack
outbound_policy.approver_personality: brand-editor
```

Notes:

- The gate exists only where a surface wires the outbox: `ethos gateway start` and `ethos boot`. `ethos chat`, `ethos serve` and `ethos cron` wire none, and `send_message` sends there exactly as it did before the field existed.
- Egress through MCP tools and `a2a_send` is not covered at all. `ethos personality show <id>` prints the posture and that exclusion on one `Publishing:` line.
- Walkthrough: [Approve posts before they go out](../how-to/approve-posts-before-sending.md).

## toolset.yaml {#toolset-yaml}

Flat YAML list of tool names. Each entry on its own line, prefixed with `- `. Tools missing from this list are filtered out before the LLM sees them.

```yaml
# ~/.ethos/personalities/researcher/toolset.yaml
- read_file
- write_file
- web_search
- web_extract
- browse_url
```

Notes:

- An empty file (or one with only comments) means the personality runs with no external tools. The file may be omitted entirely for an internal-only personality.
- Tools the personality requests but does not list are rejected by `DefaultToolRegistry` and returned to the LLM as `is_error: true` so the Anthropic tool-result contract remains intact.

## SOUL.md {#ethos-md}

The first-person identity file. Markdown, no front-matter required. Loaded as part of the system prompt at every turn — combined with memory context and the dynamic personality config.

The file is mtime-cached by `FilePersonalityRegistry.loadFromDirectory()`; the loader re-reads it only when the on-disk mtime changes, so editing it during a chat session takes effect on the next turn.

## skills/ {#skills}

Optional sibling directory at `~/.ethos/personalities/<id>/skills/`. Per-personality skill files (markdown with frontmatter). The universal skill scanner picks them up alongside the global `~/.ethos/skills/` directory. Per-personality skills are always loaded unfiltered; global skills are filtered by `capability` mode by default. Set the filter with the dotted [`skills.global_ingest.*` keys](../../building/reference/skills-tools.md#skills-global-ingest); an indented `skills:` block fails the load.

## See also {#see-also}

- [`config.yaml` reference](./config-yaml.md) — the user-level `~/.ethos/config.yaml` that picks which personality runs (different file, different schema).
- [CLI reference](./cli.md#ethos-personality) — the `ethos personality` subcommands that scaffold and edit these files.
- [Glossary: personality](../../getting-started/glossary.md#personality) — one-line definition shared across every page that names the construct.
- [Glossary: fs_reach](../../getting-started/glossary.md#fs-reach) — the path-allowlist field this file declares; backed by `ScopedStorage`.
- [Run agent tools on a remote host](../how-to/run-tools-over-ssh.md) — the `execution: remote` requirement end to end, and what the remote host is exposed to.
- [Retrieve files the agent wrote](../how-to/retrieve-agent-files.md) — `fs_reach.workdir` in practice, on a headless deployment.
- [Local voice: Kokoro TTS + Whisper large v3 STT](../how-to/local-voice.md) — configure the providers this file's `voice.*` block picks between.
- [`outbound_policy` reference](../../building/reference/outbound-policy.md) — the approval outbox this file's `outbound_policy` block switches on.
