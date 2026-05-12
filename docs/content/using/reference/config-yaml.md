---
title: "config.yaml reference"
description: "Every field in ~/.ethos/config.yaml — provider, model, channel tokens, retention TTLs, provider chain."
kind: reference
audience: user
slug: config-yaml
updated: 2026-05-12
---

`~/.ethos/config.yaml` is a flat `key: value` file. Dotted keys (e.g. `retention.messages`, `providers.0.provider`) are how nested structures appear on disk — there is no indentation-based nesting. The parser ignores quotes around values.

## Source {#source}

The full field set lives in the `EthosConfig` interface in [`apps/ethos/src/config.ts`](../../../../apps/ethos/src/config.ts). `parseConfigYaml` reads values; `writeConfig` writes them. Fields marked `@internal` are managed by the runtime (e.g. `activeContext` by `ethos set`) — do not hand-edit them.

## Minimal example {#minimal-example}

```yaml
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-...
personality: researcher
```

This is what `ethos setup` writes for a default Anthropic install. Everything below is optional.

## provider {#provider}

Type: string · Default: `anthropic` · Required (effectively)

LLM provider id. Resolved at wiring time against the registered provider list. Built-in values: `anthropic`, `openrouter`, `openai`, `ollama`, `gemini`. Custom values may resolve through plugins.

```yaml
provider: anthropic
```

## model {#model}

Type: string · Default: `claude-opus-4-7` · Required (effectively)

Model id to pass to the provider. Format depends on the provider — Anthropic uses raw model names, OpenRouter uses `vendor/model`.

```yaml
model: claude-opus-4-7
```

## apiKey {#api-key}

Type: string · Default: empty · Required

Primary provider API key. For multi-key rotation, leave this set to the most-trusted key and add fallbacks via `ethos keys add` (which writes `~/.ethos/keys.json`). The `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` env vars override this at wiring time when set.

```yaml
apiKey: sk-ant-...
```

## personality {#personality}

Type: string · Default: `researcher` · Required

Id of the default [personality](../../getting-started/glossary.md#personality). Built-ins: `researcher`, `engineer`, `reviewer`, `coach`, `operator`. User personalities live under `~/.ethos/personalities/<id>/`.

```yaml
personality: engineer
```

## memory {#memory}

Type: `markdown` | `vector` · Default: unset (treated as `markdown`)

Memory backend. `markdown` reads and writes `~/.ethos/MEMORY.md` and `~/.ethos/USER.md`. `vector` enables the SQLite + embeddings store at `~/.ethos/memory.db`.

```yaml
memory: vector
```

Notes:

- Switching backends mid-stream does not migrate data — export from one, then import into the other.
- Vector mode requires an embeddings-capable provider key.

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

## providers.\<i\>.\* {#providers-chain}

Provider fallback chain. When two or more entries are present, the runtime wraps them in a `ChainedProvider` with cooldown-based failover. Index `0` is primary; higher indices fall back in order. When only one entry is set, the top-level `provider` / `apiKey` / `model` fields are used.

| Field | Type | Description |
|---|---|---|
| `providers.<i>.provider` | string | Provider id for entry `<i>`. |
| `providers.<i>.apiKey` | string | API key for entry `<i>`. |
| `providers.<i>.model` | string | Optional model override for entry `<i>`. |
| `providers.<i>.baseUrl` | string | Optional endpoint override for entry `<i>`. |

```yaml
providers.0.provider: anthropic
providers.0.apiKey: sk-ant-...
providers.0.model: claude-opus-4-7
providers.1.provider: openrouter
providers.1.apiKey: sk-or-...
providers.1.model: anthropic/claude-opus-4-7
```

## telegramToken {#telegram-token}

Type: string · Default: unset

Bot token for the Telegram gateway. Required when `ethos gateway start` should bind a Telegram bot.

```yaml
telegramToken: 123456:ABC-DEF...
```

## discordToken {#discord-token}

Type: string · Default: unset

Bot token for the Discord gateway.

## slackBotToken {#slack-bot-token}

Type: string · Default: unset

`xoxb-` bot token for the Slack gateway. Required together with `slackAppToken` and `slackSigningSecret` for Slack to bind.

```yaml
slackBotToken: xoxb-...
slackAppToken: xapp-...
slackSigningSecret: ...
```

## slackAppToken {#slack-app-token}

Type: string · Default: unset

`xapp-` app-level token for Slack Socket Mode. See [`slackBotToken`](#slack-bot-token) for the example.

## slackSigningSecret {#slack-signing-secret}

Type: string · Default: unset

Slack request signing secret. Verifies inbound webhooks when running Slack in HTTP mode.

## emailImapHost {#email-imap-host}

Type: string · Default: unset

IMAP server hostname for the email gateway. The email block requires all six of `emailImapHost`, `emailImapPort`, `emailUser`, `emailPassword`, `emailSmtpHost`, `emailSmtpPort` to bind.

```yaml
emailImapHost: imap.gmail.com
emailImapPort: 993
emailUser: you@example.com
emailPassword: ...
emailSmtpHost: smtp.gmail.com
emailSmtpPort: 587
```

## emailImapPort {#email-imap-port}

Type: integer · Default: unset

IMAP server port. Conventional values: `993` (TLS), `143` (STARTTLS).

## emailUser {#email-user}

Type: string · Default: unset

Mailbox username — typically the full email address.

## emailPassword {#email-password}

Type: string · Default: unset

Mailbox password. Use an app-specific password where the provider supports it (Gmail, Fastmail).

## emailSmtpHost {#email-smtp-host}

Type: string · Default: unset

SMTP server hostname for outbound mail.

## emailSmtpPort {#email-smtp-port}

Type: integer · Default: unset

SMTP server port. Conventional values: `587` (STARTTLS), `465` (TLS).

## verbose {#verbose}

Type: boolean · Default: `false`

Print a per-turn timing summary (LLM time, TTFT, tool wall-clock, tokens, cost) after every chat response.

```yaml
verbose: true
```

Notes:

- Toggle within a session with [`/verbose`](./slash-commands.md#slash-verbose) — that override is session-local and never written here.

## skin {#skin}

Type: string · Default: engine default

Named [skin](../../getting-started/glossary.md#skin) override. Built-in values: `default`, `mono`, `paper`. Applies across the TUI and the web `ConfigProvider`. Personality-level skins (`personality.skin`) lose to this one — when set, the user pin wins everywhere.

```yaml
skin: mono
```

## retention.* {#retention}

Per-category TTLs for the observability store. Values accept duration strings — `30d`, `12h`, `forever`. Unset fields fall back to the runtime defaults shown below.

| Field | Default | Description |
|---|---|---|
| `retention.messages` | `365d` | Conversation message history. |
| `retention.traces` | `90d` | Turn traces. |
| `retention.spans` | `90d` | Tool / LLM spans inside traces. |
| `retention.blobs` | `7d` | Large response payloads stored out-of-band. |
| `retention.archive` | `730d` | Archive partitions. |
| `retention.events.error` | `90d` | Error events from `errors.jsonl`. |
| `retention.events.audit` | `365d` | Audit events (key rotation, personality writes, approvals). |
| `retention.events.channel` | `365d` | Channel-adapter events (pairing, dedup). |
| `retention.events.install` | `forever` | Install / migration events. Never deleted by default. |

```yaml
retention.messages: 365d
retention.traces: 90d
retention.events.error: 90d
retention.events.install: forever
```

## personalities.\<id\>.retention.* {#personalities-retention}

Per-personality retention overrides. Same sub-fields as the top-level `retention.*` block; values apply only to data tagged with the matching personality id.

```yaml
personalities.engineer-paired.retention.messages: 730d
personalities.engineer-paired.retention.traces: 180d
```

Notes:

- Only the `retention` sub-block is parsed under `personalities.<id>.*`. Other top-level keys cannot be overridden per personality from this file — set them in the personality's own `config.yaml`.

## activeContext {#active-context}

Type: managed · Required: no

Managed by `ethos set personality <id>` / `ethos set team <name>`. The runtime writes two dotted keys: `activeContext.type` (`personality` | `team`) and `activeContext.name` (id or team name). Hand-editing is not supported — values are interpreted only when both keys are present and `type` is recognised.

## File location and permissions {#file-location}

`~/.ethos/config.yaml` is written by `ethos setup` and `ethos personality set`. The companion `~/.ethos/keys.json` (chmod 600) holds the rotation pool — manage it through `ethos keys`, not by hand.

The directory can be relocated with the `ETHOS_DIR` env var.

## See also {#see-also}

- [CLI reference](./cli.md) — every `ethos` subcommand and the flags that override what config.yaml sets
- [Personality config reference](./personality-yaml.md) — the per-personality `config.yaml` and `toolset.yaml` (different file, different schema)
- [How to configure providers](../how-to/configure-providers.md) — task-shaped recipe for switching between Anthropic, OpenAI, OpenRouter, and Ollama
- [Glossary: personality](../../getting-started/glossary.md#personality) — what the term means everywhere else in the docs
