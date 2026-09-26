---
title: "Why is personality architecture, not a system prompt?"
description: "A personality is a structural component — a directory that binds prompt, tools, memory scope, and model into one atomic unit you cannot mix and match."
kind: explanation
audience: developer
slug: personality-as-architecture
updated: 2026-09-13
---

## Context

Most agent frameworks treat "personality" as a string. You hand the model a system prompt — "you are a careful reviewer" — and the agent's voice shifts. Its tools do not. Its memory does not. Its model does not. The runtime is one generalist with a costume rack.

A [personality](../../getting-started/glossary.md#personality) in Ethos is something else. It is a structural component of the runtime. A directory at `~/.ethos/personalities/<id>/`, built around three plain-text files. Switching to it atomically rebinds four dimensions of the agent: which prompt it carries, which [tools](../../getting-started/glossary.md#tool) it can call, which memory file it reads and writes, and which model handles its turns. The four move together because the framework refuses to expose them as independent knobs.

This page is the headline thesis. It explains why "personality is architecture" is a load-bearing claim rather than slogan, what the structural shape buys you that a prompt string cannot, and what the design explicitly refuses to let inside the boundary. The [using-side page](../../using/explanation/what-is-a-personality.md) covers the user-facing story of switching personalities mid-chat; this page is for the developer asking why the schema is shaped this way.

## Discussion

### The four dimensions, joined at the registry

A personality directory is built around three files, and only one of them has to exist: `SOUL.md` or `config.yaml`.

```
~/.ethos/personalities/<id>/
├── SOUL.md        first-person identity — who am I, how do I speak
├── config.yaml     name, provider, model, fs_reach, mcp_servers, plugins
└── toolset.yaml    flat list of allowed tool names
```

`SOUL.md` becomes the system prompt baseline. `config.yaml` parameterises the model declaration, filesystem reach, MCP allowlist, plugin allowlist. `toolset.yaml` is the allowlist `DefaultToolRegistry.toDefinitions(allowedTools)` filters the visible toolset against.

The [memory scope](../../getting-started/glossary.md#memory-scope) (the key that decides which memory files a turn reads and writes) is in none of the three files. Turn setup derives it from the directory name as `personality:<id>` (`memScopeId` in `packages/core/src/agent-loop/stages/turn-setup.ts`), so it moves with the personality without anyone configuring it.

When you switch personality, all four change in one step. The `AgentLoop.run()` generator reads the active personality once at the top of the turn (see `packages/core/src/agent-loop.ts`) and uses it to parameterise every subsystem call: which model to ask, which tools to expose, which memory directory to resolve, which MCP servers and plugins to fire. None of those subsystems know about the others. The personality is the binding point.

This is the structural property. The four dimensions are not bundled by convention. They are bundled because the personality is the only thing that knows about all four, and the framework reads it on every turn.

### A `PersonalityConfig` is a contract, not a config dump

The schema lives at `packages/types/src/personality.ts`. It has zero runtime dependencies — anyone in the monorepo can import the type without dragging in concrete implementations. The interface is small and load-bearing: `id`, `name`, `toolset`, `provider`, `model`, `fs_reach`, `mcp_servers`, `plugins`, `safety`, plus a handful of nested leaves like `skill_evolution` and `context_layering`.

The fact that the *count* is enforced is the design statement. A CI test (`packages/types/src/__tests__/personality-field-count.test.ts`) parses the interface, counts its fields, and fails if the result drifts from `.personality-field-count` at the repo root. Adding a field requires the `personality-schema-change` label, two-maintainer approval, and a bump to the count file in the same commit.

The friction is deliberate. The schema is the load-bearing surface — it is the answer to "what is a personality" expressed as code. Letting it accrete fields would turn the directory into a god object that knows about voice modes, response templates, channel UI, and three other concerns that do not belong here. The CLAUDE.md note is blunt: voice / TTS, emotion / sentiment, label templates, and per-channel UI affordances have all been refused. Each is a real product need; none is a personality concern.

### Concretely, what `loadFromDirectory` does

The mechanical loader lives at `extensions/personalities/src/index.ts`. `FilePersonalityRegistry.loadFromDirectory(dir)` walks the immediate subdirectories of `dir`, reads each one's files, and produces a `PersonalityConfig` for each directory that qualifies.

A directory qualifies when it holds a `config.yaml` or a `SOUL.md` (`buildConfig` in the same file). Everything else has a fallback: `name` defaults to the title-cased directory id, and a missing `toolset.yaml` leaves the personality with no toolset filter, so every registered tool is visible to it. A directory with neither file is skipped silently — no error, no warning — so a directory holding only a misspelled `config.yml` produces no personality at all. Missing files are never a load-time error; some malformed content is, such as nesting a key `parseConfigYaml` does not allow to nest, which throws naming the key.

The per-directory load is `mtime`-fingerprinted. The registry caches the parsed `PersonalityConfig` keyed by directory id; on the next `loadFromDirectory` call, it reads the `mtime` of every path it fingerprints (listed [below](#hot-reload-as-a-property-of-the-file-format)) and reuses the cached config if none changed. Calling `loadFromDirectory` per turn is cheap on the steady state and reflects edits on the changed-files state.

The implication: a personality directory is the unit of *configuration change*. Editing one file in one directory updates one personality. There is no global rebuild, no migration, no restart. The mechanism is the property; the property is what makes the iterative workflow ("tune the reviewer's tone, send a message, see the change") work.

### What the structure buys you

Three things you cannot get from a prompt string.

**Enforcement instead of advice.** The toolset is filtered at the registry. `DefaultToolRegistry.toDefinitions(allowedTools)` returns only the tool definitions the personality allows; the LLM literally cannot see a tool outside the allowlist. A defensive second check runs in `executeParallel` — calls to disallowed names return `{ ok: false, code: 'not_available' }` with the Anthropic message contract preserved (every `tool_use` still gets a `tool_result`). A reviewer with no `write_file` in its toolset cannot edit a file regardless of how persuasive a prompt-injection payload sounds. The boundary is the registry; the prompt is the explanation.

**Atomic switching.** When you go from `engineer` to `reviewer` in chat, the model swap, the toolset swap, the memory scope swap, and the prompt swap happen as one operation. There is no transient state where the engineer's write tools are exposed under the reviewer's prompt. The atomicity is what makes "the reviewer cannot edit" credible — it cannot become "the reviewer cannot edit, except for one stray turn during the switch".

**Legibility.** A personality is plain text. You can `cat SOUL.md`, `grep` your toolsets, `diff` two versions, and commit the directory to a repo. The reviewer your team uses for code review is in source control next to the code it reviews. Memory you cannot read is memory you cannot trust; the same logic applies to identity. The `FilePersonalityRegistry` at `extensions/personalities/src/index.ts` is one implementation of the `PersonalityRegistry` interface; a remote registry, a database-backed one, or a hot-reloading network share are straight ports of the contract.

### The three user-facing built-ins are not three prompt presets

Ethos ships three user-facing [built-in personalities](../../getting-started/glossary.md#built-in-personality) at `extensions/personalities/data/`: `researcher`, `engineer`, `reviewer`. They are not three voices on top of one agent. Each has its own toolset and its own memory scope, and two of them declare per-role models that suit their work.

| Personality | What its `toolset.yaml` allows | Memory scope | Models in `config.yaml` |
|---|---|---|---|
| `researcher` | Read, search, web, citations | `personality:researcher` | `trivial` `claude-haiku-4-5`, `default` and `deep` `claude-opus-4-7` |
| `engineer` | Read, write, run, test | `personality:engineer` | `trivial` `claude-haiku-4-5`, `default` `claude-sonnet-4-6`, `deep` `claude-opus-4-7` |
| `reviewer` | Read-only | `personality:reviewer` | `model: claude-sonnet-4-6` |

No built-in chooses its memory scope, because no personality can: `config.yaml` has no memory-scope key, and every turn reads and writes `personality:<id>`. The default markdown backend stores that scope under `personalities/<id>/` in the Ethos data directory (`resolveScopeDir` in `extensions/memory-markdown/src/index.ts`). The reviewer's notes on what it reviewed never reach the engineer's `MEMORY.md`, and the researcher's never reach either. The roles share context through the session instead, whose history continues across a switch.

Two system personalities — `personality-architect` and `team-architect` — are also available for building and managing other personalities. They appear in the web UI under a "System" divider.

If you set out to replicate this with prompt strings, you would write five prompts, document the convention of "only use these tools when prompt X is active", and hope every caller honoured it. The structural form makes the convention impossible to violate.

### The schema-freeze rule, restated for builders

The "what does not belong on `PersonalityConfig`" question is the one that comes up repeatedly. Four categories the schema has refused, with the reason each was rejected:

- **Voice modes / TTS engine settings.** *Which* voice a personality speaks in is identity and was granted a narrow exception (the `voice` block — `tts_voice`, `languages`, `tier`, `call_style`). *When* it speaks is not: voice modes, VAD tuning, endpointing, and per-channel speech switches are deployment concerns, because two deployments of the same personality would reasonably disagree about them. They live in `~/.ethos/config.yaml` under `voice.defaultMode` and `voice.channels.*`. See [Why is a personality a governed contract?](personality-governance.md).
- **Emotion / mood / sentiment tags.** Mood is a presentation hint, not a structural property. A reviewer being "cautious" is its identity (`SOUL.md`), not a flag.
- **Response templates.** A skill is the unit for "how do I phrase a code-review comment". Templates belong to skills because they are reusable across personalities.
- **Per-channel UI affordances.** Button labels, card layouts, Slack block kit — these are channel-adapter concerns. A personality does not know which surface is rendering it.

Each rejection has the same shape: the property is real, but the personality is not its right home. Mixing them in would mean every channel adapter, every skill, and every surface negotiates with the personality directory. The clean separation is what makes the personality a *unit*.

### Hot reload as a property of the file format

`FilePersonalityRegistry.loadFromDirectory()` fingerprints each personality directory by the `mtime` of six paths: `config.yaml`, `SOUL.md`, `toolset.yaml`, `mcp.yaml`, `tools.yaml` and the `skills/` directory (`loadOne` in `extensions/personalities/src/index.ts`). Calling it on every turn is cheap when nothing changed; when any of them changes on disk, the next turn sees the new content. No restart, no session loss, no cache to invalidate by hand.

This is the property that lets you tune a personality interactively. Edit `SOUL.md`, send the next message, watch the voice change. Edit `toolset.yaml`, ask the agent to do something it now cannot do, see the rejection. The fast feedback loop is the difference between "I can iterate on this personality" and "I have to restart the process to see if my edit worked".

The performance cost is one `Storage.mtime` call per fingerprinted path per turn. For a registry with twenty personalities that is 120 calls before the model is asked anything. On a fast filesystem this is in the noise; on a network filesystem it is measurable but bounded.

### The `fs_reach` boundary is the personality's filesystem identity

A personality's `config.yaml` can declare `fs_reach`:

```yaml
fs_reach:
  read:
    - ${ETHOS_HOME}/personalities/${self}/
    - ${ETHOS_HOME}/skills/
    - ${CWD}
  write:
    - ${ETHOS_HOME}/personalities/${self}/
    - ${CWD}
```

The substitutions resolve at `AgentLoop` construction time: `${ETHOS_HOME}` becomes `~/.ethos`, `${self}` becomes the personality's id, `${CWD}` becomes the agent's working directory. The resolved lists are handed to a `ScopedStorage` decorator that wraps the framework's `Storage`. Any read or write outside the allowlist raises a `BoundaryError`.

The file tools (`read_file`, `write_file`, `patch_file`, `search_files`) route through `ToolContext.storage`, which is the scoped storage. A researcher with no write entries cannot write; a personality whose read scope is `~/.ethos/personalities/${self}/` cannot peek at another personality's memory file. The CLAUDE.md note frames this as a defence-in-depth property — the toolset already restricts which file tool the LLM can call, and the scoped storage stops the tool from doing harm even if it was called.

This is the [fs_reach](../../getting-started/glossary.md#fs-reach) boundary. It is distinct from the storage scope of the framework itself; both enforce the personality's filesystem identity, just at different layers.

### The personality determines model routing

A personality declares its model in `config.yaml` as a **role** — `trivial`, `default`, `deep` or `dreaming` — or as an **alias** the operator defined under `modelRegistry.*` in `~/.ethos/config.yaml`: one string (`model: deep`), or one value per role as dotted keys (`model.default: sonnet`, `model.deep: opus`). A vendor model id is neither and does not parse (`parseModelDeclaration` in `packages/types/src/model-registry.ts`). The personality says what kind of model each role needs; the registry says which vendor model and which provider entry answer for it. A resolved model carries the provider entry its own registry row names (`toResolved` in `packages/core/src/model-resolution.ts`), so no personality can pair an Anthropic id with an Ollama endpoint.

`resolveTurnModel` (`packages/core/src/agent-loop/turn-model.ts`) picks each turn's model, called once per turn from `turn-setup.ts`. With a registry, the first rung that declares wins (`resolveModel`):

| Rung | Source | Applies when |
|---|---|---|
| 0 | `RunOptions.modelOverride` | A surface pins one model for one run; the voice stack uses it to answer a spoken lane on a fast model. |
| 1 | The team manifest | The turn runs in a team whose manifest names a model for the coordinator or for this personality. |
| 2 | `modelRouting.<id>` in `~/.ethos/config.yaml` | The operator names a model for this personality id. |
| 3 | The personality's `model` | It declares one. A per-role map is indexed by the requested role, falling back to `model.default`. |
| 4 | `modelRegistry.roles.<role>` | The requested role is bound to an alias. |
| 5 | `modelRegistry.default` | Nothing above applies. |

A declaration that does not resolve refuses the turn with `model_unresolved` (`turn-setup.ts`) rather than running on something else.

The wiring does not build that registry for the loop yet: `modelResolution` in `packages/wiring/src/build-agent-loop.ts` passes an empty one, and `resolveTurnModel` treats an empty registry as the legacy path — rung 0, then `modelRouting.<id>`, then the deployment's `model`. The personality's own `model` is not read on that path, so the built-ins' declarations, which are vendor ids from before the registry, change nothing today. `ethos personality show <id>` prints which source won and flags an unread declaration as `INERT` (`resolveCharacterSheetRouting` in `packages/wiring/src/tier-diagnostics.ts`).

Every turn starts on the `default` role (`activeTier` in `turn-setup.ts`). Nothing classifies a message as trivial on its own. Three triggers request another role:

| Trigger | Role | Lasts |
|---|---|---|
| `/tier trivial`, `/tier default` or `/tier deep` in `ethos chat` (`apps/ethos/src/commands/chat.ts`) | The one named | The next turn |
| The dream executor (`extensions/gateway/src/dream-executor.ts`) | `dreaming` | Each dreaming turn |
| A successful `think_deeper` call (`extensions/tools-tier/src/index.ts`) | `deep` | The next LLM call only — set in `tool-processing.ts`, consumed in `stream-step.ts` |

A successful `think_deeper` call asks for `deep` on the next LLM call, which `stream-step.ts` re-resolves through `resolveTurnModel`. On the legacy path that answer is the model the turn started on, and an escalation that does not resolve keeps that model too. Both `engineer` and `researcher` list `think_deeper` in `toolset.yaml`. Personalities can also declare a `streamingTimeoutMs` so a slow-thinking model (Opus extended thinking) gets a longer watchdog than a fast one (Haiku).

The declaration is part of the personality's structural identity. Saying `researcher` needs deep reasoning by default and `engineer` an everyday model is a role decision; which vendor model each role means on a given machine is the operator's call, made in the registry, unless `modelRouting` or a surface pins a model for the run.

### How the wiring threads a personality into the loop

`AgentLoopConfig` (see `packages/core/src/agent-loop.ts`) takes a `PersonalityRegistry`, not a single personality. The registry is the source of truth — `loadFromDirectory` discovers personalities, `get(id)` returns one, `getDefault()` returns the active default. `AgentLoop.run()` resolves the active personality from `opts.personalityId` or the default, then uses it to:

- Filter the visible toolset (`personality.toolset?.length ? personality.toolset : undefined`)
- Build the MCP server allowlist (`personality.mcp_servers ?? []`)
- Build the plugin allowlist (`personality.plugins ?? []`)
- Resolve the per-personality `fs_reach` into a `ScopedStorage`
- Apply `personality.context_engine` and `context_engine_options` to compaction
- Apply `personality.safety.injectionDefense` to untrusted-output handling
- Apply `personality.streamingTimeoutMs` to the LLM watchdog

The CLI's `apps/ethos/src/wiring.ts` and the shared `packages/wiring/src/index.ts` are where this assembly happens. The point worth noticing: `AgentLoop` knows nothing about how the personality got loaded. The registry is an interface; the file-system implementation is one choice. The same loop runs against an in-memory registry in tests with no special wiring.

### The schema is FROZEN — what the comment in the source says

`packages/types/src/personality.ts` opens with a comment block that is more important than it looks:

```
// Phase 30.8 — this schema is FROZEN.
//
// Adding a top-level field to `PersonalityConfig` requires:
//   1. A CHANGELOG entry justifying why it isn't a skill, a tool, or a memory section.
//   2. The `personality-schema-change` label on the PR.
//   3. Two-maintainer approval (enforced via branch protection).
//   4. Bumping the count in `.personality-field-count` at the repo root.
```

The mechanical CI gate (`packages/types/src/__tests__/personality-field-count.test.ts`) parses the interface and fails if the count drifts. Culture sets the rule; CI enforces it. The combination is what keeps the schema small even as the project grows.

The "common rejections" comment is below the freeze notice — the four categories already listed (voice modes, emotion tags, response templates, channel UI). They sit in the source as a reminder to the next contributor reaching for "just one more field".

### Why a directory and not a database row

A personality is a directory because:

You can read it. `cat ~/.ethos/personalities/reviewer/SOUL.md` is a complete answer to "what does the reviewer do". That answer survives `grep`, `diff`, code review, and `git log`. A database row is a query away from being readable, and the query never survives a migration.

You can version it. Commit the directory to a repo and the personality your team uses is in source control alongside the code it operates on. There is no separate "personality database" to back up, restore, or replicate across machines.

You can swap the backend without changing the contract. `PersonalityRegistry` is an interface; `FilePersonalityRegistry` is one implementation. A remote registry that fetches personalities from a service is the same contract with a different `loadFromDirectory`. The data model — an identity, a config, a toolset, and a memory scope derived from the id — is what's invariant.

You can hand-edit it. `SOUL.md` is markdown. `config.yaml` is `key: value` YAML. `toolset.yaml` is a flat list. No GUI, no admin panel, no migration tool — the file is the source of truth.

### Plugins and MCP servers are default-deny

A globally configured MCP server in `~/.ethos/mcp.json` is invisible to a personality unless that personality's `mcp_servers` list names it. An installed plugin from `extensions/plugin-loader` is dormant for a personality unless the personality's `plugins` list opts in.

This is a deliberate inversion of the "if it's installed, the agent can use it" default in most frameworks. The personality is the gate. A user who installs a database MCP server does not implicitly hand database access to every personality; the `engineer` declares `mcp_servers: [postgres]` to opt in, and the `researcher` simply does not. Same machine, same installed servers, different reach per role.

The mechanism is the same registry filter that gates tools. `DefaultToolRegistry.toDefinitions(allowedTools, { allowedMcpServers, allowedPlugins })` builds the per-turn tool list from three allowlists in one pass. The LLM never sees an MCP tool from an unauthorised server; `executeParallel` rejects calls outside the allowlist with `code: 'not_available'`.

The CLAUDE.md note labels the convention: missing or empty means no access. There is no "default-allow when unset"; the absence of a list is itself a decision.

### What the personality does not control

Some boundaries are *not* personality-scoped, on purpose. Switching personalities does not change:

- The current [session](../../getting-started/glossary.md#session) and its history. The thread continues; the next message reaches a different role.
- `USER.md`, when the surface knows who you are. A turn that carries a `userId` reads your profile from the `user:<userId>` scope, which no personality owns (`userScopeId` in `packages/core/src/agent-loop/stages/context-assembly.ts`); the gateway passes the sender's id. A turn without one reads `USER.md` from the personality's own scope, so in `ethos chat`, which passes none, it does change.
- LLM credentials. Personalities pick a model; the keys live in `~/.ethos/config.yaml`.
- The CLI surface and channel adapters. Telegram and Discord do not reload when you `/personality researcher`.

The personality controls "what the agent does and says". The boundary it does not control is "who you are and where you are". Those distinctions keep the user in continuous control of the session while the role shifts beneath them.

### Identity is in the `SOUL.md`, not the schema

A subtle property of the design is what *isn't* in `PersonalityConfig`. There is no `tone`, no `style`, no `personality_traits`. The agent's voice and reasoning style live in `SOUL.md` — markdown, first-person, opinionated. The schema is the structural surface; the prose is the identity.

This split is load-bearing. A future you can read `SOUL.md` and reason about who the agent is. A future you can read `config.yaml` and reason about what the agent can touch. Mixing them — putting "be concise" alongside `fs_reach` — would smear the boundary; structural and behavioural concerns would interleave on every page of the spec.

The cost is `SOUL.md` carries the load of being readable, opinionated, and concrete. The CLAUDE.md note labels the convention: *first-person identity (who am I, how do I speak)*. A vague `SOUL.md` produces vague behaviour. The reviewer's `SOUL.md` reads "I am a critical, evidence-based reviewer. I cite specific lines. I refuse to soften concerns to be polite." Not "you are a careful reviewer". The grammatical first person is harder for the model to argue itself out of.

### The skills layer sits underneath, not inside

A common confusion: "is a [skill](../../getting-started/glossary.md#skill) part of a personality?" The answer is no — skills are discovered globally and filtered per personality by tool reach.

`extensions/skills/` scans `~/.ethos/skills/` plus the Claude Code and project skill directories (`~/.claude/skills/`, `<cwd>/.claude/skills/`, `<cwd>/.opencode/skills/`) into a global skill pool. Other tools' home directories (`~/.openclaw/skills/`, `~/.hermes/skills/`) join the pool only when a caller opts in with `externalSources` (`extensions/skills/src/universal-scanner.ts`). For each personality, an ingest filter checks whether each skill's `required_tools` are a subset of the personality's effective tool reach (`extensions/skills/src/ingest-filter.ts`). The researcher sees skills whose required tools are read/search/browse; the engineer sees skills that touch write/run/test; the reviewer does not see skills that need write tools. A skill that declares no `required_tools` passes this check by default (`fallback_unknown` defaults to `allow`).

This means a skill that needs `write_file` does not load under `reviewer`. The skill is the same file on disk, but the per-personality filter makes it invisible to roles that lack the tools to execute it. The personality is the gate; the skill is the reusable capability that passes through it.

One directory skips the tool-reach filter. When a personality directory has a `skills/` subdirectory, the loader records it as `skillsDirs`, and `SkillsInjector.resolveSkills` (`extensions/skills/src/skills-injector.ts`) loads every skill in it for that personality alone.

### Skill evolution and the personality lifecycle

A personality can change after you write it. The agent drafts skills from its own work and can revise the Expression region of its `SOUL.md`. The structure decides where those changes land and who lets them in.

The `skill_evolution` block on `PersonalityConfig` turns drafting on. With `enabled: true`, the post-turn improvement fork (`extensions/skill-evolver/src/improvement-fork.ts`) runs after a turn with at least `min_tool_calls` successful tool calls (default 5), at most once per `cooldown_minutes` (default 60) for each personality. It can propose a new skill or an update to one. All three user-facing built-ins ship with it enabled.

`skill_evolution.scope` decides where a promoted skill lives. `liveSkillDir` (`extensions/skill-evolver/src/skill-dir.ts`) is the one function that maps it: `shared`, the default, writes to `~/.ethos/skills/`, where every personality whose tool reach matches can load it; `personality` writes to `~/.ethos/personalities/<id>/skills/`, which only that personality loads.

Nothing drafted goes live directly. Every draft becomes a candidate in the [learning inbox](../../using/explanation/learning-inbox.md) (`extensions/learning-inbox`). A candidate is promoted on a human approval, or on a `pass` replay when the auto-promotion rules allow it. Those rules (`autoPromotionDecision` in `extensions/learning-inbox/src/auto-promotion.ts`) never auto-promote a shared skill: a replay tests one personality, and a shared skill reaches all of them.

Expression revisions keep their history in the personality directory. `FilePersonalityRegistry.evolveExpression` (`extensions/personalities/src/index.ts`) snapshots the previous Expression to `.expression-history/<revision-id>.md` before it rewrites `SOUL.md`, and `revertExpression` restores from those snapshots.

Ethos does not track skill usage per personality, and nothing ranks or recommends skills by use. The observability store counts skill exposures and `get_skill` invocations for the whole deployment, grouped by skill with no personality breakdown (`skillCounts` in `extensions/observability-sqlite/src/store.ts`, read by `ethos usage`). No code feeds those counts back into which skills load.

### How this differs from neighbouring frameworks

The honest comparison lives at [Why Ethos?](../../getting-started/why-ethos.md). The short form, for this page's purposes:

LangChain, CrewAI, AutoGen — "personality" means setting a system prompt string. Tool access, memory, and model selection are independent knobs you wire together by hand. Most teams don't, and the four dimensions drift apart.

OpenClaw — closer to Ethos's model: per-agent toolsets and a prompt file. The structural binding is partial: memory scope and model routing are not first-class personality properties; they live in a separate config layer.

Hermes — emphasises persistent learning loops and self-modifying skills. A "persona" in Hermes is closer to a role label than a structural unit; the agent's tools and memory are global to the runtime, not scoped to the role.

Ethos's claim is that *all four* dimensions move together, every time, and that the framework refuses to let them be set independently. The cost of that claim is the schema-freeze rule and the directory-of-files format. The benefit is that "the reviewer cannot edit" is true the same way that "the file is owned by root" is true: enforced, not requested.

## Trade-offs

**You give up the one-super-agent mental model.** Every distinct role is a directory you commit to. Three user-facing roles is three directories, nine files. The alternative — one agent with a `mode` field and per-mode tool filters — was rejected because the resulting code path branches on the mode flag and the boundaries leak.

**You commit to a small schema.** `PersonalityConfig` is frozen. If you want a new top-level field, you do the work of justifying why it is not a [skill](../../getting-started/glossary.md#skill), not a channel-adapter config, and not a per-tool option. The friction is the feature; without it the schema would have grown to the same god-object shape every other framework's persona config eventually does.

**You give up cross-personality memory.** Every personality reads and writes its own `personality:<id>` scope, and no `config.yaml` key widens it; there is no shared scope to opt into. The reviewer cannot see the engineer's notes, which is the point: opinions about what was reviewed should not leak into what gets built. The cost is that a researcher's findings reach the engineer only through the session history, which survives a switch, or through team memory (`team:<name>`, read and written with the `team_memory_*` tools) in a team deployment.

**You give up dynamic per-turn personality assembly.** A personality is loaded at the start of the turn and used for the duration of that turn. You cannot rewrite the toolset mid-turn or swap models on the fly. The structural unit is the turn-bound role, not the per-LLM-call configuration. Use a [mesh](../../getting-started/glossary.md#mesh) of personalities (`extensions/agent-mesh/`, `extensions/team-supervisor/`) when you need different roles in one workflow.

**You pay a small cost on every turn.** The mtime-fingerprinted reload is cheap but not zero — six `mtime` reads per personality per turn. On a fast filesystem this is negligible; on a network filesystem it is measurable. The trade is the live-edit story: tuning a personality without restarting beats process restart costs by a large margin.

Alternatives considered:

- A single `personality.yaml` with a `mode` field. Rejected: the four dimensions had to move together, and a single config with a mode-flag branch is a god object the schema cannot defend.
- Personality as a function in code. Rejected: defeats hot reload, defeats version control of identity, defeats the "team shares a reviewer" workflow.
- Personality as a database row. Rejected: not readable, not greppable, requires a migration to add a field, no `diff` story.
- Tool access as a separate file unrelated to the personality. Rejected: the atomic-swap property is the headline. Joining tool access to the personality at the directory level keeps the four dimensions visibly coupled; splitting them invites drift where a personality "is" a reviewer but "can" write.
- Personality overlays / inheritance. Rejected as overengineering for v1. Three user-facing built-ins, duplicate-and-edit, is enough; overlays add a layer that obscures what a personality actually is.

## Recommended reading order

If you came here from the 90-second tour, the next three pages in order:

1. [Why does AgentLoop receive every dependency at construction?](injection-at-construction.md) — the wiring shape that makes personality-as-architecture work
2. [Why are hooks split into three execution models?](hook-execution-models.md) — Void / Modifying / Claiming
3. [Build on Ethos: quickstart](../quickstart.md) — wire AgentLoop in your own program

## See also

- [Why is a personality a governed contract?](personality-governance.md) — the schema-freeze rule and the character sheet that keep this thesis honest over time
- [Why is personality the unit, not a system prompt?](../../using/explanation/what-is-a-personality.md) — the user-facing version of this thesis
- [Why Ethos?](../../getting-started/why-ethos.md) — honest comparison to LangChain, CrewAI, OpenClaw, Hermes
- [Why does AgentLoop receive everything via config?](injection-at-construction.md) — the wiring shape that makes personality-as-architecture work
- [Why MEMORY.md and USER.md?](../../using/explanation/memory-model.md) — how memory scope cooperates with personality scope
- [Personality config reference](../../using/reference/personality-yaml.md) — every field in `config.yaml` and `toolset.yaml`
