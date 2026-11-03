---
title: "Run multiple bots from one Ethos process"
description: "Write the multi-bot config for Telegram and Slack, each bot bound to a personality or team; the next part covers isolation, adapters and startup."
kind: how-to
audience: user
slug: run-multiple-bots
time: "10 min"
updated: 2026-11-03
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
- The personalities (or teams) you intend to bind already exist. Built-in personalities (`researcher`, `engineer`, `reviewer`) are available without setup. Custom personalities live under `~/.ethos/personalities/<id>/`. Teams live under `~/.ethos/teams/<name>.yaml`.

## Source

- [`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts) — `telegram.bots` / `slack.apps` schema, `deriveBotKey()`, `validateBotBindings()`.
- [`extensions/gateway/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/gateway/src/index.ts) — the per-bot routing table and lane-key construction.

## Parts

| Part | Covers |
|---|---|
| This page | Steps 1-2: the shape of a bot entry and the Telegram and Slack config |
| [Isolation, adapters and startup](run-multiple-bots/isolation-and-start.md) | Steps 3-6: session lanes and memory, `/personality`, adapter support, start the gateway |

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

Continue with [Isolation, adapters and startup](run-multiple-bots/isolation-and-start.md).

## Verify

Open `~/.ethos/config.yaml` and check each bot entry has its credentials, a distinct `id` and a `bind.type` plus `bind.name`. The gateway rejects a duplicate `id` and an unknown `bind.name` at boot, so the real check is the startup log in [part 2](run-multiple-bots/isolation-and-start.md).

## Troubleshoot

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

## See also

- [Run multiple Telegram bots from one process](run-multi-bot-telegram.md) — Telegram-specific walkthrough, BotFather setup, group routing.
- [Connect a Telegram bot to a team](connect-telegram-to-team.md) — bind a bot to a team coordinator and auto-start the team supervisor.
- [Telegram adapter](../../platforms/telegram.md), [Slack adapter](../../platforms/slack.md), [Discord adapter](../../platforms/discord.md) — per-platform routing, allowlist, dedup, error catalog.
- [config.yaml reference](../reference/config-yaml.md) — `telegram.bots.*` and `slack.apps.*` field definitions.
- [Glossary: personality](../../getting-started/glossary.md#personality), [session](../../getting-started/glossary.md#session), [gateway](../../getting-started/glossary.md#gateway).
