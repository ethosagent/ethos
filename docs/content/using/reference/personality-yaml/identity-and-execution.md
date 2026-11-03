---
title: "Personality config: identity, model and execution fields"
description: "Personality config fields for identity, model, execution and fs reach."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Fields that identify a personality and bound what it can run and reach. Part of the [Personality config reference](../personality-yaml.md).

## name {#name}

Type: string · Default: title-cased directory id · Required

Human-readable label. Surfaces in `ethos personality list`, the picker UIs, and the chat header.

```yaml
name: Engineer Paired
```

## description {#description}

Type: string · Default: unset

One-line summary shown in pickers and `ethos personality list`.

```yaml
description: Builds and ships features for this repo.
```

## model {#model}

Type: string, or dotted role keys · Default: the deployment's `model` in `~/.ethos/config.yaml`. A declaration names a **role** (`trivial`, `default`, `deep`, `dreaming`) or an **alias** the operator defined under `modelRegistry.*` in `~/.ethos/config.yaml`. A vendor model id is neither and does not parse (`parseModelDeclaration`, [`packages/types/src/model-registry.ts`](../../../../../packages/types/src/model-registry.ts)). `resolveTurnModel` ([`packages/core/src/agent-loop/turn-model.ts`](../../../../../packages/core/src/agent-loop/turn-model.ts)) picks each turn's model:

- **With a model registry**, the first rung that declares wins: a `/model` pin for the run, a team manifest entry, [`modelRouting.<id>`](../config-yaml.md#model-routing), this `model`, `modelRegistry.roles.<role>`, then `modelRegistry.default`. A declaration that does not resolve refuses the turn with `model_unresolved` instead of running on something else.
- **Without one** — every deployment today, because the wiring hands the loop an empty registry (`modelResolution` in `packages/wiring/src/build-agent-loop.ts`) — a `/model` pin, then `modelRouting.<id>`, then the deployment's `model`. This `model` is not read and `provider` is not compared; `ethos personality show <id>` marks it inert (`resolveCharacterSheetRouting`, `packages/wiring/src/tier-diagnostics.ts`). To pin one model today, use `modelRouting.<id>`.

| Key | Used for |
|---|---|
| `model.default` | Turns that request no other role, and the fallback for any role left unset. |
| `model.trivial`, `model.deep`, `model.dreaming` | Turns that request that role: `/tier trivial`, `/tier deep`, a `think_deeper` escalation, or a dreaming run (`extensions/gateway/src/dream-executor.ts`). |

```yaml
model.default: sonnet   # aliases defined under modelRegistry.*
model.deep: opus
```

## provider {#provider}

Type: string · Default: top-level `config.yaml` `provider`

Per-personality provider override. Only meaningful when the wiring layer has the named provider registered.

```yaml
provider: openrouter
```

## platform {#platform}

Type: string · Default: unset

Channel binding hint. Recognised values (used by the load-time safety gate): `telegram`, `discord`, `slack`, `whatsapp`, `email`. Bound channels combined with `safety.approvalMode: off` are rejected at config load.

```yaml
platform: slack
```

## capabilities {#capabilities}

Type: comma-separated strings · Default: unset

Free-form capability tags. Surfaces to skill-filtering and adapter routing.

```yaml
capabilities: read, write, web
```

## streamingTimeoutMs {#streaming-timeout-ms}

Type: integer (ms) · Default: `1200000` (20 minutes) — `DEFAULT_STREAMING_TIMEOUT_MS` in [packages/core/src/agent-loop/streaming-timeout.ts](../../../../../packages/core/src/agent-loop/streaming-timeout.ts)

Watchdog for the LLM stream. If no chunk arrives within this many milliseconds, the agent aborts the stream and emits an `error` event with code `streaming_timeout`. Reset on every chunk — a slow-but-progressing stream of any total duration is unaffected, so this bounds silence, not length. Thinking-mode personalities (Opus extended thinking) inherit the 20-minute default; fast personalities (Haiku) can pick tighter to surface a wedged provider sooner.

A deployment-wide override goes in `~/.ethos/config.yaml`; this key overrides both, per personality.

```yaml
streamingTimeoutMs: 60000
```

## execution {#execution}

Type: string · Default: unset (the deployment decides)

Execution requirement — what this personality demands of wherever its execution tools (`terminal`, `run_code`, `run_tests`, `lint`) run. Two values:

- `remote` — this personality's work belongs on a machine that is **not** the one Ethos runs on. Refused under a constitution that sets `execution.requireSandbox` or `execution.forbidLocal`: a remote host is trust, not confinement.
- `none` — this personality does not execute.

```yaml
execution: remote
```

A personality states a requirement; it never names a transport. `docker`, `local` and `ssh` are machine facts two deployments of the same personality reasonably disagree about — one runs inside a container, one has no Docker daemon, one has an ssh target — so the transport is the operator's, resolved from the environment, [`~/.ethos/config.yaml`](../config-yaml.md), and the constitution. Absent means no requirement at all: an exec-bearing personality is sandboxed by default, and runs in-process when Ethos is itself containerized.

- This is **not** the remote host. The target — host, user, port, identity file, known-hosts file, remote workdir — is operator config under `execution.ssh.*` in [`~/.ethos/config.yaml`](../config-yaml.md), one per deployment. Never put a hostname, user, or key path in this file.
- **A requirement this deployment cannot meet is refused, not downgraded.** `execution: remote` with no `execution.ssh.host` configured leaves the execution tools unavailable. It does not fall back to running the work here, whatever the constitution permits — a permitting constitution grants the host, which is the one machine this personality ruled out.
- `ethos personality show <id>` prints the requirement and the resolved transport on separate lines, so you can see both what was asked for and what you got.
- An unrecognised value is a load error, not a silent drop. So are the retired transport literals `ssh`, `docker` and `local`; the error names the replacement.
- **When an edit takes effect depends on which personality you edited.** For any personality other than the one the process was started with, the requirement is re-resolved on every turn against the hot-reloaded registry — edit the file, send a message, done. For the process's *default* personality it is resolved once, eagerly, at composition, so that one needs a restart. The eager resolution is deliberate: it makes an unreachable ssh target or an unbuildable sandbox a loud startup failure rather than a surprise mid-turn.

## fs_reach.read / fs_reach.write {#fs-reach}

Type: comma-separated absolute paths · Default: AgentLoop fallback scope

Per-personality filesystem allowlist for the `read_file` / `write_file` tools. The runtime resolves these substitutions once per turn:

| Token | Resolves to |
|---|---|
| `${ETHOS_HOME}` | `~/.ethos` |
| `${self}` | This personality's id. |
| `${CWD}` | The personality's working directory — the **first** [`fs_reach.workdir`](#fs-reach-workdir) entry when declared, otherwise the process working directory. |

When unset, the fallback is:

```
read:  [~/.ethos/personalities/<self>/, ~/.ethos/skills/, ${CWD}]
write: [~/.ethos/personalities/<self>/, ${CWD}]
```

A declared list replaces the defaults for that direction — it is not merged with them. Paths outside the allowlist surface as a `BoundaryError` from `ScopedStorage` and are rendered as a user-facing tool error.

```yaml
fs_reach.read: ${CWD}, ${ETHOS_HOME}/skills, ${ETHOS_HOME}/personalities/${self}
fs_reach.write: ${CWD}, ${ETHOS_HOME}/personalities/${self}
```

Notes:

- Under the container execution posture, the derived read and write paths are the container's bind mounts (read-only and read-write respectively), so the app-layer allowlist and the OS-layer mount set never disagree.
- The active personality's derived write paths are created at startup if missing. Read-only paths are not — a read prefix that does not exist is simply an empty scope.
- Paths under `/proc`, `/sys`, `/dev`, or a Docker socket are never mounted into a container and are never pre-created.

## fs_reach.workdir {#fs-reach-workdir}

Type: one or more comma-separated absolute paths · Default: unset (the process working directory)

The personality's working directory. Each entry takes the same substitution tokens as `fs_reach.read` / `fs_reach.write` and resolves to an absolute path. The **first** entry is the personality's working directory and becomes `${CWD}` for the rest of the `fs_reach` derivation: every tool in the personality's toolset stands there, a bare relative path passed to `read_file` or `write_file` resolves against it, and the `terminal` tool runs its commands in it under both the local and the container execution posture.

```yaml
fs_reach.workdir: ${ETHOS_HOME}/workspace/${self}
```

Declare several to give the [Documents tab](../../how-to/retrieve-agent-files.md) several roots. Each entry becomes its own browsable root with its own containment boundary:

```yaml
fs_reach.workdir: ${ETHOS_HOME}/workspace/${self}, /srv/reports
```

Notes:

- The first declared entry is added to both the derived read list and the derived write list, so it stays reachable even when `fs_reach.write` is declared and therefore replaces the defaults. Later entries are **not** — a second root is browsable from Documents but out of the agent's own reach until it is listed in `fs_reach.read` / `fs_reach.write` too.
- The dotted key is the only accepted syntax — an indented `fs_reach:` block is refused at load with `Top-level key "fs_reach" cannot be a nested object in personality config`.
- A token that resolves to an empty string refuses the turn with `FS_REACH_INVALID` rather than synthesizing a path at the filesystem root.
- Unset leaves the derivation untouched: the working directory is the process working directory and the read/write lists derive exactly as they did before this field existed. The Documents tab, which has no such fallback, shows the personality as unconfigured — see [`WORKDIR_NOT_CONFIGURED`](../../../troubleshooting.md#error-reference).
- `ethos personality show <id>` prints the declared value (tokens unresolved) as a `Workdir` line under **Filesystem reach**.
- Files written here are retrievable from a browser — see [Retrieve files the agent wrote](../../how-to/retrieve-agent-files.md). Files can be uploaded into the same directory — see [Upload a file into the agent's folder](../../how-to/upload-agent-files.md).

## See also {#see-also}

- [Personality config reference](../personality-yaml.md): the index of every section and its page.
