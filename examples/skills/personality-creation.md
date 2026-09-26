# Ethos Personality Creation

Use this skill when helping a user create, edit, or debug an Ethos personality.

## What a personality is

A personality is a structural component (not just a system prompt string) that simultaneously shapes:

- **Identity / voice** — `SOUL.md` (first-person), injected at priority 110.
- **Tool access** — `toolset.yaml` declares which tools the personality is allowed to call. The registry enforces this at execution time — calls outside the allowlist return a `tool_result` with `is_error: true`.
- **Skills** — optional `skills/` directory of `*.md` files injected into the system prompt by `SkillsInjector` (priority 100).
- **Routing & runtime** — `config.yaml` sets the model declaration, provider, platform, and mesh-advertised capabilities. Memory scope is not configured: a personality's memory is always its own (`personality:<id>`).

A personality is loaded by `FilePersonalityRegistry.loadFromDirectory()` (mtime-cached, hot-reloadable).

## File structure

```
<id>/                  ← directory name = personality id (lowercase, no spaces)
├── config.yaml        ← name, description, provider, model, capabilities
├── SOUL.md           ← first-person identity ("I am ...", "I do ...")
├── toolset.yaml       ← optional but recommended: flat list of allowed tool names
└── skills/            ← optional: per-personality skill markdown files
    ├── <skill>.md
    └── ...
```

At least one of `config.yaml` or `SOUL.md` must exist for the directory to register as a personality.

## Installation locations

```
~/.ethos/personalities/<id>/         user (any project)
extensions/personalities/data/       built-in (monorepo only)
examples/plugins/personality/        packaged via plugin (api.registerPersonality)
```

For a packaged personality (npm or local plugin), use `api.registerPersonality({...})` plus an injector at priority 110 with `shouldInject: ctx => ctx.personalityId === '<id>'` — see `examples/plugins/personality/src/index.ts`.

## `config.yaml` schema (flat key: value, no nesting)

| Key | Required | Notes |
|---|---|---|
| `name` | yes | Display name (e.g. `Engineer`). Defaults to title-cased id. |
| `description` | yes | One-line summary used in `/personality` listings. |
| `provider` | no | Shown on the character sheet. Model selection does not read it: a registry alias carries its own provider entry (`toResolved` in `packages/core/src/model-resolution.ts`). |
| `model` or `model.trivial` / `model.default` / `model.deep` / `model.dreaming` | no | A role (`trivial`, `default`, `deep`, `dreaming`) or a `modelRegistry` alias — one string, or one per role. A vendor id does not parse (`parseModelDeclaration` (`packages/types/src/model-registry.ts`)). With no registry configured the declaration is not read and turns run on the deployment model (`resolveTurnModel` (`packages/core/src/agent-loop/turn-model.ts`)); `modelRouting.<id>` in `~/.ethos/config.yaml` overrides it either way. |
| `platform` | no | Restrict to a platform (`cli`, `telegram`). |
| `capabilities` | no | Comma-separated mesh roles, e.g. `code, review`. Advisory; not the same as `toolset`. |

The parser is `parseConfigYaml()` in `extensions/personalities/src/index.ts`. It supports `key: value` lines and dotted keys (`model.default`, `memory.provider`) — no lists, no multiline. Nesting any key other than `safety` fails the load. Quotes around values are stripped.

## `toolset.yaml` schema (flat YAML list)

```yaml
- read_file
- write_file
- web_search
```

Common built-in tools to choose from:

| Group | Tools |
|---|---|
| File | `read_file`, `write_file`, `patch_file`, `search_files` |
| Terminal | `terminal`, `process_start`, `process_list`, `process_kill`, `execute_code`, `run_tests`, `lint` |
| Web | `web_search`, `web_extract`, `web_crawl` |
| Memory | `memory_read`, `memory_write`, `session_search` |

If `toolset.yaml` is omitted, the personality gets all registered tools. Always declare the minimum needed — toolsets are enforced at the registry level, so a tighter list is real isolation, not a hint.

`capabilities` ≠ `toolset`. Capabilities are labels advertised to the mesh router; toolset is the hard allowlist of tool names the personality may call.

## `SOUL.md` writing rules

First-person identity. Read like the agent describing itself, not a manual about the agent.

- Open with `# <Name>` and a one-sentence statement of role: "I am a software engineer agent."
- Use "I do X" / "I don't do Y" — not "you should" or "the agent will".
- State *behavioral* rules: how it handles errors, padding, tradeoffs, clarifying questions, output format.
- Keep it short (10–20 lines). Long ETHOS files dilute focus.
- Don't repeat what's in `toolset.yaml` or `config.yaml`. Identity, not config.

Reference exemplars in `extensions/personalities/data/`:
- `engineer/SOUL.md` — terse, code-first
- `archived/coach/SOUL.md` — warm but direct, asks questions (archived: not loaded)
- `researcher/SOUL.md` — methodical, primary-source bias
- `reviewer/SOUL.md` — critical, evidence-based
- `archived/operator/SOUL.md` — cautious, confirms before irreversible actions (archived: not loaded)

## Per-personality `skills/`

Drop markdown files in `<id>/skills/`. Each file is appended to the system prompt by `SkillsInjector` (priority 100) when this personality is active. Global `~/.ethos/skills/` files are also injected.

Two formats supported:

1. Plain markdown — injected verbatim.
2. OpenClaw frontmatter — YAML frontmatter with `metadata.openclaw.{requires, os, always}` rules. See `extensions/skills/src/skill-compat.ts`.

Discovery: top-level `*.md`, plus `<dir>/<slug>/SKILL.md`, plus `<dir>/<scope>/<slug>/SKILL.md`. Files in a `pending/` subdir or starting with `.` are skipped.

## Workflow for creating a new personality

1. **Pick the id** — lowercase, single word, no spaces. The directory name is the id.
2. **Pick the model** — name a role: `trivial` for fast lookups, `default` for code/review, `deep` for planning/coaching; use per-role keys (`model.default`, `model.deep`) or registry aliases only when the role needs them.
3. **Decide what must be shared** — a personality's memory is always its own. Anything another agent needs goes in team memory: add `team_memory_read` / `team_memory_write` to the toolset.
4. **Write SOUL.md first** — identity drives every other choice.
5. **Derive toolset from identity** — a coach doesn't need `terminal`; an operator does.
6. **Write config.yaml last** — name, description, provider, model, capabilities.
7. **Verify** — start `ethos`, run `/personality <id>`, check the personality loads and the model resolves.

## Common mistakes

- **Nested YAML in `config.yaml`** — only `safety` may be nested. `model:\n  default: claude-...` fails the load; write `model.default: claude-...`.
- **`capabilities` written as YAML list** — must be a comma-separated string (`code, review`), not `- code\n- review`.
- **Missing `SOUL.md`** — a directory with only `config.yaml` will register, but the agent has no identity injection. Always include both.
- **`toolset.yaml` with hyphens but indented** — lines must start with `- ` at column 0 (after trimming). Indented entries are ignored.
- **Identity written in third person** — "The agent should be terse" reads like a spec, not a self. Rewrite as "I am terse."
- **A vendor id as the model** — `model: claude-sonnet-4-6` is neither a role nor an alias. With no registry it is not read and the personality runs on the deployment model; once a registry exists the turn is refused with `model_unresolved`. Write a role or an alias.
- **Expecting shared memory** — there is no `memoryScope` field. One personality's `MEMORY.md` never reaches another's prompt; use team memory for anything that must cross.
- **Writing the personality as a plugin without registering an identity injector** — `api.registerPersonality({...})` adds the config, but you also need an injector at priority 110 to inject the SOUL.md content.
- **Choosing a model id that doesn't exist** — model resolution happens per-turn; an unknown model throws at runtime, not at load time.

## Where to look for help

- `extensions/personalities/src/index.ts` — `FilePersonalityRegistry`, `parseConfigYaml`, `parseToolsetYaml`, `loadFromDirectory`
- `extensions/personalities/data/<built-in>/` — the loaded built-ins; retired ones sit under `data/archived/`, which the loader skips
- `packages/types/src/personality.ts` — `PersonalityConfig` interface
- `extensions/skills/src/skills-injector.ts` — how `skillsDirs` and `~/.ethos/skills/` are merged and injected
- `examples/plugins/personality/src/index.ts` — packaging a personality as a plugin
