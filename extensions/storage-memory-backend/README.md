# @ethosagent/storage-memory-backend

## Purpose

A plugin that registers the `memory` storage backend, an in-process `InMemoryStorage` from `@ethosagent/storage-fs`, with the host. It exists as a minimal worked example of a storage plugin (`ethos.type` is `plugin` in `package.json`) and holds no storage logic of its own.

## Public surface

Single entry point `.` (`src/index.ts`) with a default export only.

| Export | Kind | One line |
|---|---|---|
| `default` | const | An `EthosPlugin` whose `activate` calls `registerStorage('memory', ...)` on the plugin API. |

`package.json` declares `ethos.pluginContractMajor` 4. Nothing else is exported.

## Seam

Uses `EthosPlugin` and `EthosPluginApi.registerStorage` from `@ethosagent/plugin-sdk` (`packages/plugin-sdk/src/index.ts`) and the `InMemoryStorage` implementation of `Storage`. Layer `extensions`. Limitation: nothing in this package or a test names the `memory` backend as a supported production choice; the host only exposes `registerStorage` when it wires a storage registry.

## Testing

```
pnpm vitest run extensions/storage-memory-backend
```

No tests in this package.
