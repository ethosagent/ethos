---
title: "Why does a personality carry its own filesystem reach and model routing?"
description: "The fs_reach boundary and model routing as parts of a personality."
kind: explanation
audience: developer
updated: 2026-11-03
---

## Context

A personality names the files it may reach and the model it routes to; this page explains why both live on the personality.

## Discussion

### The `fs_reach` boundary is the personality's filesystem identity

A personality's `config.yaml` can declare `fs_reach`:

```yaml
fs_reach:
  read:
    - ${ETHOS_HOME}/personalities/${self}/
    - ${ETHOS_HOME}/skills/
    - ${CWD}
  write:
    - ${ETHOS_HOME}/personalities/${self}/
    - ${CWD}
```

The substitutions resolve at `AgentLoop` construction time: `${ETHOS_HOME}` becomes `~/.ethos`, `${self}` becomes the personality's id, `${CWD}` becomes the agent's working directory. The resolved lists are handed to a `ScopedStorage` decorator that wraps the framework's `Storage`. Any read or write outside the allowlist raises a `BoundaryError`.

The file tools (`read_file`, `write_file`, `patch_file`, `search_files`) route through `ToolContext.storage`, which is the scoped storage. A researcher with no write entries cannot write; a personality whose read scope is `~/.ethos/personalities/${self}/` cannot peek at another personality's memory file. The CLAUDE.md note frames this as a defence-in-depth property — the toolset already restricts which file tool the LLM can call, and the scoped storage stops the tool from doing harm even if it was called.

This is the [fs_reach](../../../getting-started/glossary.md#fs-reach) boundary. It is distinct from the storage scope of the framework itself; both enforce the personality's filesystem identity, just at different layers.

### The personality determines model routing

A personality declares its model in `config.yaml` as a **role** — `trivial`, `default`, `deep` or `dreaming` — or as an **alias** the operator defined under `modelRegistry.*` in `~/.ethos/config.yaml`: one string (`model: deep`), or one value per role as dotted keys (`model.default: sonnet`, `model.deep: opus`). A vendor model id is neither and does not parse (`parseModelDeclaration` in `packages/types/src/model-registry.ts`). The personality says what kind of model each role needs; the registry says which vendor model and which provider entry answer for it. A resolved model carries the provider entry its own registry row names (`toResolved` in `packages/core/src/model-resolution.ts`), so no personality can pair an Anthropic id with an Ollama endpoint.

`resolveTurnModel` (`packages/core/src/agent-loop/turn-model.ts`) picks each turn's model, called once per turn from `turn-setup.ts`. With a registry, the first rung that declares wins (`resolveModel`):

| Rung | Source | Applies when |
|---|---|---|
| 0 | `RunOptions.modelOverride` | A surface pins one model for one run; the voice stack uses it to answer a spoken lane on a fast model. |
| 1 | The team manifest | The turn runs in a team whose manifest names a model for the coordinator or for this personality. |
| 2 | `modelRouting.<id>` in `~/.ethos/config.yaml` | The operator names a model for this personality id. |
| 3 | The personality's `model` | It declares one. A per-role map is indexed by the requested role, falling back to `model.default`. |
| 4 | `modelRegistry.roles.<role>` | The requested role is bound to an alias. |
| 5 | `modelRegistry.default` | Nothing above applies. |

A declaration that does not resolve refuses the turn with `model_unresolved` (`turn-setup.ts`) rather than running on something else.

The wiring does not build that registry for the loop yet: `modelResolution` in `packages/wiring/src/build-agent-loop.ts` passes an empty one, and `resolveTurnModel` treats an empty registry as the legacy path — rung 0, then `modelRouting.<id>`, then the deployment's `model`. The personality's own `model` is not read on that path, so the built-ins' declarations, which are vendor ids from before the registry, change nothing today. `ethos personality show <id>` prints which source won and flags an unread declaration as `INERT` (`resolveCharacterSheetRouting` in `packages/wiring/src/tier-diagnostics.ts`).

Every turn starts on the `default` role (`activeTier` in `turn-setup.ts`). Nothing classifies a message as trivial on its own. Three triggers request another role:

| Trigger | Role | Lasts |
|---|---|---|
| `/tier trivial`, `/tier default` or `/tier deep` in `ethos chat` (`apps/ethos/src/commands/chat.ts`) | The one named | The next turn |
| The dream executor (`extensions/gateway/src/dream-executor.ts`) | `dreaming` | Each dreaming turn |
| A successful `think_deeper` call (`extensions/tools-tier/src/index.ts`) | `deep` | The next LLM call only — set in `tool-processing.ts`, consumed in `stream-step.ts` |

A successful `think_deeper` call asks for `deep` on the next LLM call, which `stream-step.ts` re-resolves through `resolveTurnModel`. On the legacy path that answer is the model the turn started on, and an escalation that does not resolve keeps that model too. Both `engineer` and `researcher` list `think_deeper` in `toolset.yaml`. Personalities can also declare a `streamingTimeoutMs` so a slow-thinking model (Opus extended thinking) gets a longer watchdog than a fast one (Haiku).

The declaration is part of the personality's structural identity. Saying `researcher` needs deep reasoning by default and `engineer` an everyday model is a role decision; which vendor model each role means on a given machine is the operator's call, made in the registry, unless `modelRouting` or a surface pins a model for the run.

## Trade-offs

See [Trade-offs](../personality-as-architecture.md#trade-offs) on [Why is personality architecture, not a system prompt?](../personality-as-architecture.md).

## See also

- [Why is personality architecture, not a system prompt?](../personality-as-architecture.md) — the parent page.
