---
title: "Run multiple bots from one Ethos process: isolation, adapters and startup"
description: "Per-bot session lanes and memory, /personality on bound bots, adapter support, startup"
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Confirm how bots stay isolated, decide whether a bound bot may switch personality, and start the gateway with every configured bot.

## Result

`ethos gateway start` prints one online line per bot, and each bot replies in its own persona with its own session history.

## Prereqs

- Complete [part 1](../run-multiple-bots.md): `~/.ethos/config.yaml` lists each bot with credentials, an `id` and a `bind`.

## Steps

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

Memory follows the personality, not the bot. Every turn reads and writes its personality's own `~/.ethos/personalities/<id>/MEMORY.md` and `USER.md` — the scope is fixed at `personality:<id>`, with no setting to widen it — so bots bound to different personalities never see each other's memory, and bots bound to the same personality share it. The gateway also resolves each sender through `~/.ethos/users/identity-map.json`, keyed by platform and platform user id, and a turn with a resolved user reads `~/.ethos/users/<userId>/USER.md`; when that file is non-empty it replaces the personality's copy in the prompt. That profile follows one account across every bot on its platform. The same person on Telegram and on Slack has two user ids until you point both entries at one.

### 4. Understand what `/personality` does on identity-bound bots

`/personality` is **disabled** by default for bots bound with `bind.type: personality` or `bind.type: team`. Sending `/personality researcher` to a bound bot returns a rejection message; the bot keeps its configured identity.

To allow per-chat personality switching on a specific bot, set `bind.allowSlashSwitch: true` on that entry. Default is `false` for identity-bound bots — leave it that way for bots intended to have a stable, consistent persona.

### 5. Adapter support today

| Platform | Multi-bot support | Notes |
|---|---|---|
| Telegram | full | `telegram.bots` list, per-bot `botKey` stamped on every inbound. See [Run multiple Telegram bots](../run-multi-bot-telegram.md). |
| Slack | full | `slack.apps` list, per-bot `botKey` stamped on every inbound. See [Slack adapter](../../../platforms/slack.md). |
| Discord | **partial** | The adapter does not yet stamp `botKey` on `InboundMessage`. In a multi-bot deployment, Discord inbound messages route to the gateway's `defaultBotKey` fallback (single-bot deployments only) or are dropped with an observability event. Tracked on the [Discord parity plan](../../../platforms/discord.md#whats-shipped-vs-in-flight). |
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

The outbound dedup cache is keyed by `(sessionId, sha256(content))`, plus the inbound message on a reply (`replyDedupScope`). Since each bot has its own session lane, two bots in the same channel can emit identical text on the same turn without one being suppressed.

## Troubleshoot

**A bot rotates its token and loses its history.**

When `id` is not set, `botKey` is derived from `sha256(token)`. Rotating the token changes the `botKey`, which changes the lane key, which means the new bot starts with no session history. Set an explicit `id:` on every bot you operate long-term to make the binding survive token rotation.

**A Discord bot in a multi-bot deployment is silent.**

Discord doesn't stamp `botKey` on `InboundMessage` yet — see the [parity plan](../../../platforms/discord.md#whats-shipped-vs-in-flight). For now, run Discord bots either as the only adapter or under separate `HOME` roots.

**The gateway warns about a legacy scalar being ignored.**

You have both `telegramToken` (or the Slack scalar triple) and the matching list form set. Remove the scalar — the list wins. Keep the credentials by adding them as a list entry.
