# @ethosagent/plugin-loader

Discovers and activates third-party Ethos plugins from `~/.ethos/plugins/`, `.ethos/plugins/`, and npm `node_modules`.

## Why this exists

Ethos's core registries (tools, hooks, injectors) accept registrations at construction time. The plugin-loader lets external packages register tools / hooks / injectors at startup *without* modifying the CLI's wiring code. It bridges `@ethosagent/plugin-contract` (the public schema for what makes a directory or npm package a plugin) and `@ethosagent/plugin-sdk` (the `PluginApi` handed to each plugin's `activate()` function), so plugins can be shipped, installed, and loaded the same way regardless of source.

Without this extension, every new tool or hook would have to be wired manually in `apps/ethos/src/wiring.ts`.

## What it provides

- `PluginLoader` class — discovery, activation, and lifecycle (`unload`, `unloadAll`, `list`, `isLoaded`).
- Two kinds of discovery source. USER sources, loaded first: `~/.ethos/plugins/<name>/`, then `~/.ethos/plugins/node_modules`. WORKSPACE sources, loaded after them and only with a trust grant: `<cwd>/.ethos/plugins/<name>/` and `<cwd>/node_modules/{ethos-plugin-*,@ethos-plugins/*,@ethosagent/*}`.
- Per-plugin `PluginApiImpl` instance (from `@ethosagent/plugin-sdk`) so `unload()` can call `cleanup()` and roll back every registration.

## How it works

`loadAll()` runs the user sources, then the workspace sources. Among the user sources a later one with the same plugin id overrides an earlier one (`~/.ethos/plugins/node_modules` beats `~/.ethos/plugins/<name>/`). Each source delegates to `loadFromPluginDir()` or `scanNodeModulesDir()`.

### Workspace plugins need a trust grant

A plugin inside the working directory arrived with whatever repo was cloned, not by an install decision, and importing it runs its code with your keys — in `ethos chat`, `serve`, `gateway`, and an `ethos acp` an IDE spawns on the folder it opened. So a workspace plugin is skipped, with a warning naming the command, until you grant it:

```
ethos plugin trust [dir]     # every workspace plugin under dir (default: cwd)
ethos plugin untrust [dir]
```

The grant is keyed on the plugin directory AND a sha256 of its files (`trustWorkspacePlugin`, `src/workspace-trust.ts`), stored through `Storage` at `~/.ethos/plugins/workspace-trust.json`. Any added, removed or edited file — a `git pull` included — voids it until you trust again. A workspace plugin also never replaces an id your user sources already provide: it is skipped with a warning instead. Both rules are enforced by `PluginLoader.workspaceGate` before any of the plugin's code or skills load, and pinned by `src/__tests__/workspace-trust.test.ts`.

The grant covers what executes under it. The hash includes a nested `node_modules/` (only `.git/` is skipped, `hashPluginTree`), and nothing outside the plugin folder may run or contribute skills:

- **Imports are contained to the folder.** Before a trusted workspace plugin is imported, `guardWorkspacePluginImports` (`src/workspace-import-guard.ts`) registers its real path with a synchronous `module.registerHooks` resolve hook. Any resolution from a module inside the folder to a file outside it is refused before it evaluates: a relative `../../lib/x.js`, an absolute path, a bare dependency hoisted to `<cwd>/node_modules` or a pnpm sibling, a symlink pointing out. This covers static imports (refused at link time, before any of the graph runs), dynamic `import()` and `require()`. `node:` builtins and `data:` URLs are allowed. Hashing the import graph instead would not be sound, because `import()` takes computed specifiers. As a result, a trusted workspace plugin must be self-contained: vendor its dependencies into its own folder. Pinned in a real process by `src/__tests__/workspace-import-guard.test.ts`.
- **`skills_dir` must stay inside the folder.** A workspace plugin whose `ethos.skills_dir` resolves outside it is refused with a warning (`PluginLoader.workspaceSkillsDirEscapes`). Pinned by the 'covers what executes' cases in `src/__tests__/workspace-trust.test.ts`.
- **Symlinks are hashed as their link text, never read through.** A pnpm-installed dependency (`node_modules/dep -> .pnpm/dep@1.0.0/node_modules/dep`) is trusted like any other file: its real files are hashed where they live, and retargeting the link voids the grant. A symlink whose target resolves outside the folder refuses the grant with an error naming the link (`hashPluginTree`), and a trusted plugin that gains one is skipped with a warning (`PluginLoader.workspaceGate`). Pinned by the 'over symlinks' cases in `src/__tests__/workspace-trust.test.ts`.

Not covered: `node:` builtins and the Ethos process itself, including everything handed to the plugin through `activate(api)`. The containment hook runs only in Node's own resolver, so it is not in effect under a test runner that resolves `import()` itself (vitest). A grant is consent, not a sandbox: a trusted plugin runs in-process with full privileges.

`loadFromPluginDir()` (`src/index.ts:69`) resolves an entry point in this order: `index.ts`, `index.js`, `src/index.ts`, `src/index.js`, then `package.json#main` (`src/index.ts:211`). It then dynamically `import()`s the entry, checks for an `activate` export, constructs a per-plugin `PluginApiImpl`, and calls `activate(api)`. If `activate` throws, `api.cleanup()` is called and the plugin is silently dropped.

`loadFromNodeModules()` only inspects project packages whose name matches `ethos-plugin-*`, `@ethos-plugins/*` or `@ethosagent/*` (`projectNodeModulesCandidates`) — this keeps the scan O(filtered packages), not O(all dependencies). Each candidate's `package.json` is checked with `isEthosPlugin()` from `@ethosagent/plugin-contract`, which validates the `ethos.type === "plugin"` field.

`unload(id)` calls `plugin.deactivate?.()` (errors swallowed), then `api.cleanup()` to undo every `register*()` call the plugin made (each `register*` returns a cleanup function that the SDK accumulates). Reloading is `unload` + `activate` — `activatePlugin` (`src/index.ts:172`) calls `unload` first if the id already exists.

## On-disk layout

Per-directory plugin (works in `~/.ethos/plugins/<name>/`, or `<cwd>/.ethos/plugins/<name>/` once trusted):

```
<plugin-name>/
  index.ts | index.js | src/index.ts | src/index.js   # must export activate(api)
  package.json                                        # optional, used to resolve "main"
  plugin.yaml                                         # mentioned in code comment but not actually read
```

npm-installed plugin (in any `node_modules/`):

```
node_modules/ethos-plugin-foo/
  package.json   # must contain { "ethos": { "type": "plugin" } }
                 # entry resolved via main, exports["."], or default index.js
```

## Gotchas

- The doc comment says `loadFromPluginDir` "must contain either `plugin.yaml` or `package.json`" but the implementation only resolves the entry file — `plugin.yaml` is never parsed. A directory with just an `index.ts` exporting `activate` will load.
- Scoped npm packages are discovered by recursing into the `@ethos-plugins` scope directory (`src/index.ts`). Only the literal `@ethos-plugins` scope is scanned — other scopes (e.g. `@my-org`) are skipped to keep the scan O(filtered packages).
- All discovery / activation failures are silent except for `console.warn` calls; no error propagates from `loadAll()`. The CLAUDE.md notes this package is one of the few allowed to use `console.warn`.
- Plugin order matters for hooks (handlers run in registration order for sequential models like `fireModifying` and `fireClaiming` — see core's hook-registry).
- `unloadAll()` iterates `[...this.plugins.keys()]` (a snapshot) so plugins added during deactivation don't cause iteration issues.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `PluginLoader` class — discovery (dir + node_modules), entry resolution, activation, lifecycle. |
| `src/__tests__/plugin-loader.test.ts` | Tests for directory loading, npm scanning, and unload semantics. |
