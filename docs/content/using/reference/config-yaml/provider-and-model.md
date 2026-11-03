---
title: "config.yaml: provider and model keys"
description: "config.yaml keys that pick the provider, model, key and personality."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys that choose which provider and model answer a turn. Every key is optional once `provider`, `model` and `apiKey` are set. Part of the [config.yaml reference](../config-yaml.md).

## schemaVersion {#schema-version}

Type: integer · Default: `1` · Required: no

Config file schema version. `writeConfig` emits it as the first line of every write; the current version is `1` (`CURRENT_ETHOS_CONFIG_SCHEMA_VERSION`). A file without the line is treated as `schemaVersion: 1`, with a one-time startup warning suggesting `ethos setup` or adding the line by hand.

```yaml
schemaVersion: 1
```

## provider {#provider}

Type: string · Default: `anthropic` · Required (effectively)

LLM provider id. Resolved at wiring time against the registered provider list. Built-in values: `anthropic`, `openrouter`, `openai`, `ollama`, `gemini`. Custom values may resolve through plugins.

```yaml
provider: anthropic
```

## model {#model}

Type: string · Default: `claude-opus-5-5` · Required (effectively)

Model id to pass to the provider. Format depends on the provider — Anthropic uses raw model names, OpenRouter uses `vendor/model`. The parser (`parseConfigYaml` in `packages/config/src/index.ts`) falls back to `claude-opus-5-5`, the catalog's Anthropic default, when the line is absent; the two are pinned equal by `packages/wiring/src/__tests__/config-default-model.test.ts`. `ethos setup` defaults to the selected provider's catalog default (`getDefaultModel` in `packages/wiring/src/model-catalog.ts`).

```yaml
model: claude-sonnet-5
```

## apiKey {#api-key}

Type: secret reference · Default: empty · Required

Primary provider API key, as a `${secrets:<ref>}` reference. `ethos setup` stores the value in the vault under `providers/<provider>/apiKey` and writes the reference here; rotate it with `ethos secrets set providers/<provider>/apiKey <value>`. Every write refuses a recognizable plaintext key in this field (`validateNoPlaintextSecrets` in `packages/config/src/index.ts`). For multi-key rotation, leave this set to the most-trusted key and add fallbacks via `ethos keys add` (which writes `~/.ethos/keys.json`). The `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` env vars override this at wiring time when set.

```yaml
apiKey: ${secrets:providers/anthropic/apiKey}
```

## personality {#personality}

Type: string · Default: `researcher` · Required

Id of the default [personality](../../../getting-started/glossary.md#personality). Built-ins: `researcher`, `engineer`, `reviewer`. System: `personality-architect`, `team-architect`. User personalities live under `~/.ethos/personalities/<id>/`.

```yaml
personality: engineer
```

## baseUrl {#base-url}

Type: string · Default: provider default

Override the provider's API endpoint. Required for OpenAI-compatible providers (OpenRouter, Ollama, local proxies).

```yaml
baseUrl: https://openrouter.ai/api/v1
```

## modelRouting.\<personality\> {#model-routing}

Type: string · Default: falls back to top-level `model`

Per-personality model override. The key is a personality id; the value is a model string for that personality's provider.

```yaml
modelRouting.researcher: claude-opus-4-7
modelRouting.engineer: moonshotai/kimi-k2.6
```

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
