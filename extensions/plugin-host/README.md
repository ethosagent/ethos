# @ethosagent/plugin-host

## Purpose

Runs a third-party plugin's code in its own child process, so the main Ethos process no longer shares memory, environment, registries or secrets with it. A crash, hang or OOM in the plugin becomes a tool error for that call; the turn continues. Opt-in per plugin (plan `plan/phases/plugin-process-isolation.md`). This package is the host runtime; the loader seam, config keys, secrets/capability serving and the OS sandbox live in other lanes.

It is crash isolation, memory isolation and an audited API boundary. It is not a sandbox: without an OS wrapper a plugin can still read any file the Ethos uid can read, vault files included.

## Public surface

Exported from `src/index.ts`; the child entry is the `./child` export.

| Export | Kind | One line |
|---|---|---|
| `PluginHostPool` | class | One host per plugin per process: leases, spawn, crash and restart policy, ping, `dispose()`. |
| `createPluginActivator` | function | The `PluginActivator` (type defined in `@ethosagent/plugin-loader`) the loader calls for a hosted plugin. |
| `HostConnection` | class | JSON-RPC correlation over one pipe: id ownership, stray-response drops, violation callback. |
| `LineCodec`, `PROTOCOL_VERSION`, method tables | protocol | NDJSON framing, 8 MiB frame limit, typed `ethos/...` methods. |
| `runPluginHostChild` (`./child`) | function | The child process main loop; re-exported by `@ethosagent/wiring` for `apps/ethos/src/plugin-host-child.ts`. |

## Seam

Archcheck layer: `extensions`. It depends on `@ethosagent/plugin-loader` (the child loads plugins through `PluginLoader.loadFromPluginDir`, so the dynamic `import()` stays under EX-005) but plugin-loader never imports it. The pool uses only an injected `Storage` for host directories; there is no raw `node:fs` and no `console.*`.

The child rebinds `process.stdout.write` to stderr before any plugin code is imported, so a plugin's `console.log` cannot corrupt a frame. A malformed line or an oversize frame is a protocol violation and kills the host (`HostConnection`, pinned by `src/__tests__/protocol.test.ts`).

Crash, backoff (1 s doubling to 60 s, +/-20%), circuit (5 crashes in 10 min opens it for 30 min), ping (30 s, 5 s timeout), cancel grace and shutdown order are pinned by `src/__tests__/lifecycle.test.ts`.

## Registrations and the reverse side

Every `EthosPluginApi` member is classified in `src/__tests__/registration-inventory.test.ts` (`INVENTORY`, typed so a new member fails typecheck until it is classified) and every `ToolContext` key in `src/__tests__/tool-context-host-hop.test.ts` (`HOST_HOP`). Injectors, tool filters, evaluators, routes, health checks, slash/CLI commands, document extractors, data rows and the event bus are replayed in `src/proxies/`; the child records them through `src/child/api-tap.ts` (it wraps `PluginApiImpl`'s prototype inside the host process only, because the loader builds the api privately and several registrations never reach `PluginRegistries`). Unsupported members (context engine, LLM/memory/storage/execution/platform/STT/TTS providers, `registerCustomOAuthFlow`, `registerOAuth`) fail the plugin's load naming the method.

The host-to-parent handler table is assembled in `src/parent-handlers.ts` (`createParentHandlers`): `ethos/capability.*` is served from the call's own live handle (`src/capability-server.ts`), a revoked or foreign handle answers `PLUGIN_HOST_HANDLE_REVOKED` and records `plugin_host.denied`; `ethos/secrets.*` and `capability.secret` go through the injectable `authorizeSecretRef` (default: deny everything outside `plugins/<id>/`) and then the parent's own `PluginApiImpl`. `PluginHostPoolOptions.parent` carries the injection points (`authorizeSecretRef`, `listSecretKeys`, `llmFactory` for monitors).

## Not yet in this package

Secret authorisation policy, tool-capability clamping, env scrubbing and the OS sandbox (`secrets.ts`, `capabilities.ts`, `env.ts`, `sandbox.ts`) are a later lane. `getContext`/`setContext` are absent in a host (synchronous). `onCredentialUpdate` handlers fire host-side for the host's own `setSecret`; an operator-side update is not forwarded.

## Testing

```
source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @ethosagent/plugin-host test
```

Tests spawn real children from source with `--import tsx`; `src/__tests__/helpers/mock-host.mjs` stands in for a host to drive failure paths quickly. Fixture plugins are plain JS under `src/__tests__/fixtures/`.
