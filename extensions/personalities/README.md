# @ethosagent/personalities

Filesystem-backed `PersonalityRegistry` with six built-in personalities and an mtime-cached loader for user overrides.

## Why this exists

In Ethos, a personality is structural — it shapes tool access, model routing, and prompt content all at once (see the root `CLAUDE.md`, "Adding a personality"). The core `AgentLoop` only knows the `PersonalityRegistry` interface from `@ethosagent/types`; this extension is the concrete implementation that reads `SOUL.md` / `config.yaml` / `toolset.yaml` from disk and turns them into `PersonalityConfig` records the loop can resolve every turn.

Without this extension there are no personalities to choose from, so `AgentLoop` would have nothing to consult when filtering tools or selecting a model.

## What it provides

- `FilePersonalityRegistry` — implements `PersonalityRegistry`, holds an in-memory map keyed by personality id with an mtime fingerprint per personality directory.
- `createPersonalityRegistry()` — async factory that returns a registry pre-loaded with the six built-ins.
- A `data/` directory shipped alongside `src/` containing the built-in personalities.

Built-ins shipped in `data/`:

| id | model | purpose |
|---|---|---|
| `researcher` | `model.default: claude-opus-4-7` (`provider: anthropic`) | Methodical research, primary sources, flagged uncertainty. Default. |
| `engineer` | `model.default: claude-sonnet-4-6` (`provider: anthropic`) | Terse, code-first. |
| `reviewer` | deployment model | Code/plan review personality. |
| `personality-architect` | deployment model | System personality: authors other personalities. |
| `team-architect` | deployment model | System personality: composes personalities into teams. |
| `debug` | deployment model | System personality (`SYSTEM_PERSONALITY_IDS`). |

Tier keys apply only while `provider` matches the active LLM. `reviewer` and the system personalities write a plain `model:` string, which the loader parses and turn setup never applies (`resolveModelWithTier`, `packages/core/src/agent-loop/turn-context.ts`). Retired personalities (`coach`, `coordinator`, `operator`, `task-tracker`) sit under `data/archived/`; that directory has no `config.yaml` or `SOUL.md` of its own, so the loader skips it.

## How it works

`createPersonalityRegistry()` calls `loadBuiltins()`, which resolves the bundled `data/` directory via `join(import.meta.dirname, '..', 'data')` (see `src/index.ts:89`). `import.meta.dirname` is the Node 21.2+ replacement for the old `fileURLToPath(new URL(...))` workaround — see the root `CLAUDE.md` "Learnings" section for why we use it directly.

Wiring then calls `loadFromDirectory(~/.ethos/personalities)` on top of the built-ins, so user-defined personalities can override any built-in id — `compose()` in `src/compose.ts`, and the agent loop re-runs the load before each turn through `refreshPersonalities` (`createAgentLoop`, `packages/wiring/src/build-agent-loop.ts`). Defaulting works the same way: `loadBuiltins()` makes `researcher` the default, and `compose()` calls `setDefault(opts.personality)` on top when the config names one.

`loadOne()` fingerprints six paths per directory by mtime — `config.yaml`, `SOUL.md`, `toolset.yaml`, `mcp.yaml`, `tools.yaml` and the `skills/` directory. If none changed, the personality is not re-read — so a surface can call `loadFromDirectory()` cheaply before every turn for hot-reload.

`buildConfig()` is permissive: a directory needs only `config.yaml` *or* `SOUL.md` to be considered a personality. Missing `toolset.yaml` means the personality has no toolset filter, and `AgentLoop` will expose every registered tool to the LLM (toolset-based filtering only kicks in when `personality.toolset` is set — see `tool-registry.ts:57`).

The YAML parsers are intentionally minimal — `parseConfigYaml` reads line by line: flat `key: value` lines, dotted keys (`model.default`, `memory.provider`), and the short allowlist of nested blocks in `NESTED_BLOCKS` (nesting any other key throws). `parseToolsetYaml` accepts only flat `- item` lists. No external YAML dependency.

## On-disk layout

```
~/.ethos/personalities/<id>/
  config.yaml      # name, description, provider, platform, model.<tier>,
                   # memory.provider, capabilities (CSV), streamingTimeoutMs
                   # (this or SOUL.md must exist)
  SOUL.md         # first-person identity prompt (this or config.yaml must exist)
  toolset.yaml     # flat - <tool_name> list (optional)
  skills/          # directory of skill markdown files (optional)
```

`extensions/personalities/data/<id>/` follows the same shape — that's how the five built-ins are stored.

## Gotchas

- A directory with neither `config.yaml` nor `SOUL.md` is silently ignored (`buildConfig`).
- `config.yaml` is flat `key: value` lines plus dotted keys (`model.default`, `skills.global_ingest.mode`). Only the blocks in `NESTED_BLOCKS` (today `safety:`) may be indented; indenting any other key — `skills:`, `model:` — throws and the personality does not load. Multiline values are not supported.
- `capabilities` is comma-separated *inside the value*, not a YAML list (`code, file, terminal`).
- The fingerprint includes the `skills/` directory's own mtime, not the skill files inside it: adding or removing a skill file reloads the personality, editing one in place does not.
- `getDefault()` falls back to the first inserted personality if `defaultId` is unknown, then to a hard-coded `{ id: 'default', name: 'Default' }` if the registry is empty.
- `loadFromDirectory()` swallows ENOENT — a missing personalities directory is treated as no personalities, not an error.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `FilePersonalityRegistry`, `createPersonalityRegistry`, YAML parsers, mtime cache. |
| `src/__tests__/personalities.test.ts` | Loader, mtime cache, and built-in coverage tests. |
| `data/<id>/` | Bundled built-in personalities (researcher, engineer, coach, operator, reviewer). |
