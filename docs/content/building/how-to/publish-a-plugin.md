---
title: "Publish a plugin"
description: "Package an Ethos plugin against the EthosPlugin contract: scaffold, plugin module and build config. Part 2 covers tests and npm publish."
kind: how-to
audience: developer
slug: publish-a-plugin
time: "15 min"
updated: 2026-11-03
---

## Task

Build, package, and publish an Ethos [plugin](../../getting-started/glossary.md#plugin) to npm so any user can install it with `ethos plugin install <pkg>` and the loader registers its tools, hooks, and providers at startup.

## Result

A package named `ethos-plugin-<name>` (or `@<scope>/ethos-plugin-<name>`) on npm. After `ethos plugin install <pkg>`, the [tool](../../getting-started/glossary.md#tool), [hook](../../getting-started/glossary.md#hook), and [personality](../../getting-started/glossary.md#personality) registrations the plugin declares appear in `ethos doctor` and become reachable to any personality whose toolset and plugin allowlist include them.

## Prereqs

- Node 24+ and pnpm (or npm) on `PATH`.
- An npm account with publish rights to your scope; `npm whoami` returns your handle.
- Ethos checked out or installed locally — you'll import types from `@ethosagent/plugin-sdk` (`workspace:*` if you're inside the monorepo, otherwise a published version).
- A clear idea of what the plugin adds: one to five tightly related tools, hooks, or providers. Anything broader belongs in two plugins.

## Parts

| Part | Covers |
|---|---|
| This page | Steps 1-3: scaffold the package, define the plugin module, add build config. |
| [Test and publish](./publish-a-plugin/test-and-publish.md) | Steps 4-6: tests against real registries, required config, build and `npm publish`. |

## Steps

### 1. Scaffold the package

```bash
mkdir ethos-plugin-myplugin
cd ethos-plugin-myplugin
pnpm init
```

Set the `name`, `description`, the `ethos.type` manifest field, and the contract major. `PLUGIN_CONTRACT_MAJOR` in `@ethosagent/plugin-contract` is currently `4`. The loader accepts any `ethos.pluginContractMajor` inside the inclusive supported range — `2` through `4` today — and rejects anything outside it.

```json
{
  "name": "@yourscope/ethos-plugin-myplugin",
  "version": "0.1.0",
  "description": "Adds X to Ethos via a single tool.",
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "keywords": ["ethos", "ethos-plugin"],
  "ethos": {
    "type": "plugin",
    "pluginContractMajor": 4
  },
  "peerDependencies": {
    "@ethosagent/plugin-sdk": ">=0.1.0",
    "@ethosagent/types": ">=0.1.0"
  },
  "devDependencies": {
    "@ethosagent/plugin-sdk": "^0.1.0",
    "@ethosagent/types": "^0.1.0",
    "tsup": "^8",
    "typescript": "^5",
    "vitest": "^4"
  }
}
```

Package names starting with `ethos-plugin-` or scoped under `@ethos-plugins/` are auto-discovered when the user runs `ethos plugin install`. Other names work too, but the user must add them by full id to `~/.ethos/config.yaml`.

### 2. Define the plugin module

Every plugin exports an `activate(api)` function. The loader instantiates one `EthosPluginApi` per plugin, calls `activate`, and tracks every registration so `unload()` can remove it later.

```ts title="src/index.ts"
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { defineTool, ok } from '@ethosagent/plugin-sdk/tool-helpers';

const greetTool = defineTool<{ name: string }>({
  name: 'greet',
  description: 'Greet someone by name.',
  toolset: 'hello',
  schema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  async execute({ name }) {
    return ok(`Hello, ${name}.`);
  },
});

async function onSessionStart(payload: {
  sessionId: string;
  platform: string;
}): Promise<void> {
  console.error(`[myplugin] session ${payload.sessionId} on ${payload.platform}`);
}

export function activate(api: EthosPluginApi): void {
  api.registerTool(greetTool);
  api.registerVoidHook('session_start', onSessionStart);
}

export function deactivate(): void {
  // Tools and hooks are removed by PluginApiImpl.cleanup() automatically.
  // Only release external resources here (DB pools, timers, sockets).
}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
```

`EthosPluginApi` exposes 28 registration methods. The six you are most likely to start with are `registerTool`, `registerVoidHook`, `registerModifyingHook`, `registerInjector`, `registerPersonality`, and `registerContextEngine`. See the [plugin SDK reference](../reference/plugin-sdk.md) for the full list and signatures.

### 3. Add build config

The plugin ships compiled ESM with type declarations. The Ethos loader does a dynamic `import()` of `dist/index.js`.

```ts title="tsup.config.ts"
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
});
```

```json title="tsconfig.json"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

Continue with [Test and publish](./publish-a-plugin/test-and-publish.md).

## Verify

Type-check the package. Expect no output.

```bash
pnpm exec tsc --noEmit
```

## Troubleshoot

**`Plugin "<name>" declares pluginContractMajor=N, but Ethos's current plugin contract is major=1`.** — The loader rejected the package before importing it. Bump `ethos.pluginContractMajor` in `package.json` to match the current major and republish.

**`"<name>" has no activate() or register() export — skipping`.** — The entry point resolved but the module does not expose `activate`. Confirm `dist/index.js` exports a named `activate` function (or a default object with one).

**`ECONNREFUSED` or `EACCES` inside `activate`.** — `activate` runs synchronously during startup; do not open sockets, read large files, or call APIs there. Lazy-init inside the tool's `execute`.
