---
title: "Create a plugin: test, install and local scaffold"
description: "Register a data source, test with real registries, install the plugin and scaffold a local plugin directory."
kind: how-to
audience: developer
time: "10 min"
updated: 2026-11-03
---

## Task

Register a data source, test the plugin, install it and scaffold a local plugin directory.

## Result

An installed plugin that passes `ethos doctor`, plus a local `my-notes` directory ready for code.

## Prereqs

- Complete [part 2](./activate-and-register.md): `activate()` registers the tools and extensions.

## Steps

### 15. Register a data source (optional)

Use `api.registerDataSource()` to expose a SQLite database for read-only dashboard queries.

```ts
api.registerDataSource({
  name: 'finance-history',
  description: 'Historical trade data.',
  dbPath: '~/.ethos/plugins/my-plugin/trades.db',
});
```

See [Register a plugin data source](../register-plugin-data-source.md) for the full walkthrough.

### 16. Test

Instantiate `PluginApiImpl` with real registries from `@ethosagent/core`, call `activate(api)`, then assert tools are registered:

```ts title="src/__tests__/activate.test.ts"
const tools = new DefaultToolRegistry();
const api = new PluginApiImpl('my-plugin', {
  tools, hooks: new DefaultHookRegistry(), injectors: [],
  injectorPluginIds: new Map(), personalities: new DefaultPersonalityRegistry(),
  llmProviders: new DefaultLLMProviderRegistry(),
  memoryProviders: new DefaultMemoryProviderRegistry(),
  filters: [], evaluators: [], routes: [],
});
activate(api);
assert(tools.get('stock_lookup'));
```

Use `mockTool` and `createTestRuntime` from `@ethosagent/plugin-sdk/testing` for end-to-end tests.

### 17. Install and activate

```bash
pnpm build && ethos plugin install . && ethos plugin credentials my-plugin
```

Add tools to the personality's `toolset.yaml`: `stock_lookup`, `authed_search`.

---

## Local development workflow

Custom tools for your agent, slash commands for your workflow, data sources that feed dashboards — all from one package. If the scaffold-and-publish path above feels heavyweight for experimentation, this section shows the faster loop: create a plugin directory, write code, install locally, test, iterate.

### Scaffold a plugin directory

Create the plugin directory and initialize it:

```bash
mkdir -p ~/.ethos/plugins/my-notes/src
cd ~/.ethos/plugins/my-notes
pnpm init
pnpm add -D typescript @ethosagent/plugin-sdk @ethosagent/types
```

Edit `package.json` to include the `ethos` block. The `pluginContractMajor` must be `2` — the loader rejects mismatches.

```json
{
  "name": "ethos-plugin-my-notes",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "ethos": {
    "type": "plugin",
    "id": "my-notes",
    "pluginContractMajor": 2
  }
}
```

The plugin id must be unique across all installed plugins.

The resulting directory tree:

```
~/.ethos/plugins/my-notes/
├── package.json
├── node_modules/
└── src/
    └── index.ts
```

## Verify

```bash
ethos plugin list              # shows plugin id and tool count
ethos personality show finance-analyst
ethos doctor my-plugin         # runs health checks, reports monitor status
```

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| Tool not visible to LLM | Missing from `toolset.yaml`. | Add the tool name. |
| `No credential storage` | Plugin not registered. | Run `ethos plugin install .`. |
