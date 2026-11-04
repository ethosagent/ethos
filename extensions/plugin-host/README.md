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

## Not yet in this package

Parent-side proxies for injectors, filters, evaluators, routes, monitors, commands and the other registry rows, the secrets and capability servers, env scrubbing and the sandbox are later lanes. A plugin that registers an unsupported member (context engine, LLM or memory provider, storage, execution backend, platform adapter, STT/TTS, custom OAuth flow) fails to load in a host, naming the method.

## Testing

```
source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @ethosagent/plugin-host test
```

Tests spawn real children from source with `--import tsx`; `src/__tests__/helpers/mock-host.mjs` stands in for a host to drive failure paths quickly. Fixture plugins are plain JS under `src/__tests__/fixtures/`.
