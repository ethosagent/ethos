---
title: "Run multiple bots from one Ethos process"
description: "Host several Telegram bots and Slack apps in one gateway, each bound to a distinct personality or team, with isolated sessions and memory."
kind: how-to
audience: user
slug: run-multiple-bots
time: "10 min"
updated: 2026-05-17
---

## Task

Configure two or more channel bots — across Telegram and Slack — in a single Ethos [gateway](../../getting-started/glossary.md#gateway) process, with each bot bound to a distinct [personality](../../getting-started/glossary.md#personality) or [team](../../getting-started/glossary.md#team).

## Result

- One Ethos process hosts `N` bots. Each has its own external identity, its own personality (or team coordinator), its own [sessions](../../getting-started/glossary.md#session).
- A user DMing `@researcher_bot` and `@engineer_bot` from the same account gets two distinct histories that never merge.
- The startup log lists every configured bot. Sessions, memory scope, and dedup keys are isolated per bot.
- One `~/.ethos/config.yaml`, one set of secrets, one daemon.

## Prereqs

- `ethos chat` works locally with a configured LLM provider.
- For each bot you want to run: the credentials (Telegram BotFather token, or Slack bot+app+signing-secret triple).
- The personalities (or teams) you intend to bind already exist. Built-in personalities (`researcher`, `engineer`, `reviewer`, `coach`, `operator`) are available without setup. Custom personalities live under `~/.ethos/personalities/<id>/`. Teams live under `~/.ethos/teams/<name>.yaml`.

## Source

- [`apps/ethos/src/config.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/config.ts) — `telegram.bots` / `slack.apps` schema, `deriveBotKey()`, `validateBotBindings()`.
- [`extensions/gateway/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/gateway/src/index.ts) — the per-bot routing table and lane-key construction.

## Steps

### 1. Understand the shape

In the multi-bot config, each platform takes a list of entries. Every entry has:

- **`token`** (Telegram) or **`botToken` + `appToken` + `signingSecret`** (Slack) — the credentials that identify this bot to its platform.
- **`id`** (optional) — a stable, human-readable key used for log output, session lane names, and the `Map<botKey, AgentLoop>` the gateway maintains internally. When omitted, the gateway derives a `botKey` from the first 24 hex chars of `sha256(token)`. The derived key is stable across restarts as long as the token does not change.
- **`bind.type`** — `personality` or `team`. The binding is static: a bot does not change identity at runtime.
- **`bind.name`** — the personality id (for `bind.type: personality`) or team name (for `bind.type: team`).

Set `id` explicitly when you want logs and lane keys to read `researcher-bot:12345` instead of `7a1c9b4e2f0d6e8b3a5c1f9d:12345`. Once you set `id`, do not change it — changing the `id` orphans existing session history. If you only rely on the sha256-derived default, rotating the token changes the `botKey` and starts the bot with a fresh history.

See [AGENTS.md "Channel adapter contract"](https://github.com/ethosagent/ethos/blob/main/AGENTS.md) for the underlying contract every adapter follows.

### 2. Write the config

Use one section per platform. Both can coexist in the same file.

#### Telegram

```yaml
# ~/.ethos/config.yaml

telegram.bots.0.token: "123456:ABCdefGhIJklmNopQRstuVwxYZ"
telegram.bots.0.id: researcher-bot
telegram.bots.0.bind.type: personality
telegram.bots.0.bind.name: researcher

telegram.bots.1.token: "654321:XYZabcDeFgHijKlMnOpqRsTuV"
telegram.bots.1.id: engineer-bot
telegram.bots.1.bind.type: personality
telegram.bots.1.bind.name: engineer

telegram.bots.2.token: "789012:LMNopqRsTuVwXyZAbCdEfGh"
telegram.bots.2.id: eng-team-bot
telegram.bots.2.bind.type: team
telegram.bots.2.bind.name: eng
```

#### Slack

```yaml
# ~/.ethos/config.yaml

slack.apps.0.botToken: "xoxb-…"
slack.apps.0.appToken: "xapp-…"
slack.apps.0.signingSecret: "abc123…"
slack.apps.0.id: researcher-slack
slack.apps.0.bind.type: personality
slack.apps.0.bind.name: researcher

slack.apps.1.botToken: "xoxb-…"
slack.apps.1.appToken: "xapp-…"
slack.apps.1.signingSecret: "def456…"
slack.apps.1.id: engineer-slack
slack.apps.1.bind.type: personality
slack.apps.1.bind.name: engineer
```

Bot `id` lives in a single namespace across `telegram.bots` and `slack.apps` — the gateway rejects a config that reuses the same `id` for two entries, regardless of platform. Pick distinct names.

If a `bind.name` references a personality or team that doesn't exist on disk, the gateway fails loudly at boot rather than silently routing traffic into nowhere.

### 3. Understand session lane isolation

The gateway maintains one `AgentLoop` instance per configured bot, indexed by `botKey`. Every inbound message is stamped with the receiving bot's `botKey`, and the lane key the gateway uses to route it is:

```
${platform}:${botKey}:${chatId}
```

This is the structural shift from single-bot mode. Concretely:

| Config | Lane key |
|---|---|
| Single bot (legacy `telegramToken` scalar) | `telegram:<chatId>` |
| Multi-bot (`telegram.bots` list) | `telegram:<botKey>:<chatId>` |
| Single Slack app (legacy scalar fields) | `slack:<chatId>` |
| Multi-bot (`slack.apps` list) | `slack:<botKey>:<chatId>` |

Two bots in the same Slack channel (or the same Telegram group) get separate sessions. The user's history with `researcher-bot` never leaks into `engineer-bot`'s context, and vice versa.

Memory follows the same boundary. A bot bound to a personality with `memoryScope: 'per-personality'` writes to `~/.ethos/personalities/<id>/MEMORY.md` — and only sees that file. `USER.md` is shared across bots within one Ethos process, because it represents the same human regardless of which bot they happen to be talking to.

### 4. Understand what `/personality` does on identity-bound bots

`/personality` is **disabled** by default for bots bound with `bind.type: personality` or `bind.type: team`. Sending `/personality researcher` to a bound bot returns a rejection message; the bot keeps its configured identity.

To allow per-chat personality switching on a specific bot, set `bind.allowSlashSwitch: true` on that entry. Default is `false` for identity-bound bots — leave it that way for bots intended to have a stable, consistent persona.

### 5. Adapter support today

| Platform | Multi-bot support | Notes |
|---|---|---|
| Telegram | full | `telegram.bots` list, per-bot `botKey` stamped on every inbound. See [Run multiple Telegram bots](run-multi-bot-telegram.md). |
| Slack | full | `slack.apps` list, per-bot `botKey` stamped on every inbound. See [Slack adapter](../../platforms/slack.md). |
| Discord | **partial** | The adapter does not yet stamp `botKey` on `InboundMessage`. In a multi-bot deployment, Discord inbound messages route to the gateway's `defaultBotKey` fallback (single-bot deployments only) or are dropped with an observability event. Tracked on the [Discord parity plan](../../platforms/discord.md#whats-shipped-vs-in-flight). |
| Email | partial | Same caveat as Discord — no `botKey` stamping yet. |

The legacy scalar shapes (`telegramToken`, `slackBotToken`/`slackAppToken`/`slackSigningSecret`) still work for one-bot deployments and are not going away in the current major version. When both the scalar and the list form are present, the list wins and the gateway logs a deprecation warning at startup. Migrate to the list form when you add a second bot.

### 6. Start the gateway

```bash
ethos gateway start
```

Expected output — one line per bot:

```
ethos gateway  starting...
✓ Telegram online — researcher-bot (312ms)
✓ Telegram online — engineer-bot (340ms)
✓ Telegram online — eng-team-bot (298ms)
✓ Slack online — researcher-slack (501ms)
✓ Slack online — engineer-slack (487ms)
Listening for messages. Press Ctrl+C to stop.
```

## Verify

**Startup log lists every configured bot.**

Each line shows the `id` from config (or the derived `botKey` prefix if `id` is omitted). A missing line means that bot's credentials failed validation — check the log for the per-bot error.

**Each bot replies in its own persona.**

DM each bot with the same prompt. The replies should reflect the bound personality — `researcher-bot` answers in the researcher voice, `engineer-bot` in the engineer voice, and so on.

**Sessions are isolated.**

Ask `researcher-bot` a question that establishes context ("my project is named Foo"). Then ask `engineer-bot` "what's my project called?" — `engineer-bot` has no idea, because their sessions never share state.

**Same content, both bots — both replies.**

The outbound dedup cache is keyed by `(sessionId, sha256(content))`. Since each bot has its own session lane, two bots in the same channel can emit identical text on the same turn without one being suppressed.

## Troubleshoot

**A bot rotates its token and loses its history.**

When `id` is not set, `botKey` is derived from `sha256(token)`. Rotating the token changes the `botKey`, which changes the lane key, which means the new bot starts with no session history. Set an explicit `id:` on every bot you operate long-term to make the binding survive token rotation.

**Startup logs a duplicate `botKey` error.**

```
slack.apps[1]: duplicate botKey 'researcher-slack'. Set an explicit 'id:' to disambiguate.
```

Two entries (within or across platforms) resolved to the same `botKey`. Set distinct `id:` values.

**Startup logs an unknown personality or team.**

```
telegram.bots[2]: bind.name='eng' is not a known team. Add a team manifest at ~/.ethos/teams/eng.yaml, or fix the binding.
```

The `bind.name` references an entity that doesn't exist on disk. The gateway refuses to start rather than route traffic to nowhere. Add the personality or team manifest, or fix the typo.

**A Discord bot in a multi-bot deployment is silent.**

Discord doesn't stamp `botKey` on `InboundMessage` yet — see the [parity plan](../../platforms/discord.md#whats-shipped-vs-in-flight). For now, run Discord bots either as the only adapter or under separate `HOME` roots.

**The gateway warns about a legacy scalar being ignored.**

You have both `telegramToken` (or the Slack scalar triple) and the matching list form set. Remove the scalar — the list wins. Keep the credentials by adding them as a list entry.

## See also

- [Run multiple Telegram bots from one process](run-multi-bot-telegram.md) — Telegram-specific walkthrough, BotFather setup, group routing.
- [Connect a Telegram bot to a team](connect-telegram-to-team.md) — bind a bot to a team coordinator and auto-start the team supervisor.
- [Telegram adapter](../../platforms/telegram.md), [Slack adapter](../../platforms/slack.md), [Discord adapter](../../platforms/discord.md) — per-platform routing, allowlist, dedup, error catalog.
- [config.yaml reference](../reference/config-yaml.md) — `telegram.bots.*` and `slack.apps.*` field definitions.
- [Glossary: personality](../../getting-started/glossary.md#personality), [session](../../getting-started/glossary.md#session), [gateway](../../getting-started/glossary.md#gateway).
