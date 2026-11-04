---
title: "config.yaml: plugin isolation keys"
description: "config.yaml keys that run a plugin in its own host process: plugins.isolation, per-plugin overrides and the plugins.host.* limits."
kind: reference
audience: user
updated: 2026-11-04
---

## Synopsis {#synopsis}

Keys that move a plugin out of the Ethos process and into a child process of its own, so a crash or a runaway heap in the plugin cannot take the agent down. Part of the [config.yaml reference](../config-yaml.md).

Host mode is crash and memory isolation plus an audited API boundary: the plugin reaches secrets, storage and the LLM only through calls the parent checks and logs. It is **not a sandbox**. Unless `plugins.host.sandbox` is `auto`, the host is an ordinary process under your user account and can still read any file you can, including the secrets vault under `~/.ethos/`. Do not treat `host` as protection against a plugin you do not trust.

Defaults apply when no key is set: every plugin runs in-process, as before.

## plugins.isolation {#plugins-isolation}

Type: `in-process` | `host` · Default: `in-process`

Where plugins run when nothing more specific applies.

| Value | Meaning |
|---|---|
| `in-process` | **(default)** The plugin is imported into the Ethos process. |
| `host` | The plugin runs in a host child process, one host per plugin. The host starts when the plugin first activates. |

Notes:

- First-party `@ethosagent/*` packages installed under `node_modules` always run in-process, whatever this key says. A directory named `@ethosagent/*` under `~/.ethos/plugins/` is not first-party.
- A plugin the catalog marks `community` always runs in `host`. Setting it to `in-process` is refused and the loader reports a notice. Both rules are in `resolvePluginIsolation` (`extensions/plugin-loader/src/isolation-policy.ts`, pinned by `isolation-policy.test.ts`).
- An invalid value is a warning at load and the default is kept.
- A plugin that resolves to `host` on a surface that cannot spawn hosts is not loaded; it never silently falls back to in-process (`isolation-seam.test.ts`, "no activator wired + host configured fails closed").

```yaml
plugins.isolation: host
```

## plugins.isolation.\<id\> {#plugins-isolation-id}

Type: `in-process` | `host` · Default: the value of `plugins.isolation`

Per-plugin override. `<id>` is the plugin id. The override wins over `plugins.isolation`, except for the two fixed rules above.

```yaml
plugins.isolation: in-process
plugins.isolation.acme-crm: host
```

## plugins.host.sandbox {#plugins-host-sandbox}

Type: `none` | `auto` · Default: `none`

| Value | Meaning |
|---|---|
| `none` | **(default)** No OS confinement. The host can read the vault files under `~/.ethos/`. |
| `auto` | Wrap each host in macOS `sandbox-exec` or Linux `bwrap`, with a profile that denies the vault paths. If no wrapper is available the host does not start (`PLUGIN_HOST_SANDBOX_UNAVAILABLE`, `extensions/plugin-host/src/sandbox.ts`). |

`auto` limits file access. It does not give per-hostname network control, and Ethos does not attest it as a security boundary. The value is parsed by `buildPluginIsolation` in `packages/config/src/index.ts`; any other value is a warning and `none` is kept.

```yaml
plugins.host.sandbox: auto
```

## plugins.host.hook_timeout_ms {#plugins-host-hook-timeout-ms}

Type: integer, at least `100` · Default: `2000`

How long a hook handler or other short parent-to-host request may take. A hook that times out counts as no result and later handlers still run. Tool calls have no such timeout; they stop through the turn's abort signal.

```yaml
plugins.host.hook_timeout_ms: 5000
```

## plugins.host.idle_stop_minutes {#plugins-host-idle-stop-minutes}

Type: integer, at least `0` · Default: `10`

Minutes a host may sit unused before it is stopped. The next call to the plugin starts it again with no backoff, and the stop is not counted as a crash. `0` keeps hosts up until Ethos stops. A host that holds a monitor, a route or an event-bus subscription never idles, and neither does one with a call in flight. Each stop records `plugin_host.stopped` with reason `idle`. Pinned by `extensions/plugin-host/src/__tests__/idle-stop.test.ts`.

After a plugin's first start, Ethos caches its registration list in `plugin-hosts/<id>/registrations.json`. On later boots a matching cache registers the plugin's tools without starting its host, and the host starts on the first call. A changed version, `plugins.lock` integrity, entry mtime, secret key set or protocol version ignores the cache. Pinned by `extensions/plugin-host/src/__tests__/registration-cache.test.ts`.

```yaml
plugins.host.idle_stop_minutes: 30
```

## plugins.host.max_heap_mb {#plugins-host-max-heap-mb}

Type: integer, at least `64` · Default: `512`

V8 old-space limit for each host, passed as `--max-old-space-size`. A host that exceeds it crashes and goes through the restart path, which backs off from 1 s to 60 s and opens a circuit for 30 minutes after 5 crashes in 10 minutes (`extensions/plugin-host/src/backoff.ts`). The agent turn that was using it sees a failed tool result.

```yaml
plugins.host.max_heap_mb: 256
```

## Observability {#observability}

Each host call is recorded as a `plugin_call` span and each host lifecycle step as a `plugin_host.*` event in `observability.db`. `ethos perf --kind plugin_call` lists the slowest calls. These rows carry names, sizes and timings, never secret values. Span rows have an empty trace id, so join them to a turn through the `tool_call_id` attribute.

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
- [config.yaml: logs, backup and trust keys](operations.md)
