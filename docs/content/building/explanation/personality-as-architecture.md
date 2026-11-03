---
title: "Why is personality architecture, not a system prompt?"
description: "A personality is a structural component — a directory that binds prompt, tools, memory scope, and model into one atomic unit you cannot mix and match."
kind: explanation
audience: developer
slug: personality-as-architecture
updated: 2026-11-03
---

## Context

Most agent frameworks treat "personality" as a string. You hand the model a system prompt — "you are a careful reviewer" — and the agent's voice shifts. Its tools do not. Its memory does not. Its model does not. The runtime is one generalist with a costume rack.

A [personality](../../getting-started/glossary.md#personality) in Ethos is something else. It is a structural component of the runtime. A directory at `~/.ethos/personalities/<id>/`, built around three plain-text files. Switching to it atomically rebinds four dimensions of the agent: which prompt it carries, which [tools](../../getting-started/glossary.md#tool) it can call, which memory file it reads and writes, and which model handles its turns. The four move together because the framework refuses to expose them as independent knobs.

This page is the headline thesis. It explains why "personality is architecture" is a load-bearing claim rather than slogan, what the structural shape buys you that a prompt string cannot, and what the design explicitly refuses to let inside the boundary. The [using-side page](../../using/explanation/what-is-a-personality.md) covers the user-facing story of switching personalities mid-chat; this page is for the developer asking why the schema is shaped this way.

## Parts

| Part | Covers |
|---|---|
| This page | Context, the four dimensions, the contract, built-ins, schema freeze, hot reload, trade-offs. |
| [Why does a personality carry its own filesystem reach and model routing?](./personality-as-architecture/filesystem-and-model.md) | `fs_reach` and model routing. |
| [Why is the personality wired into the loop, frozen and kept as a directory?](./personality-as-architecture/wiring-and-schema.md) | Loop wiring, the frozen schema, directory vs database row. |
| [Why are plugins default-deny, and where do identity and skills sit?](./personality-as-architecture/plugins-identity-skills.md) | Default-deny plugins and MCP, what a personality does not control, identity, skills, neighbouring frameworks. |

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
