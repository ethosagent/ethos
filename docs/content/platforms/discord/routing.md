---
title: "Discord adapter: routing and channel mode"
description: "Route Discord guild channels and DMs to sessions and set the channel mode."
kind: how-to
audience: shared
time: "5 min"
updated: 2026-11-03
---

## Task

Route Discord guild channels and DMs to per-channel sessions and set the default channel mode.

## Result

- Channels and DMs each get their own session keyed `discord:<channel-id>` / `discord:<user-id>`.

## Prereqs

- The earlier steps on [Discord adapter](../discord.md) are done.

## Steps

### 4. Understand routing

`messageHandler` produces an `InboundMessage` per `MessageCreate`. The gateway keys per `(platform, chatId)`:

| Source | `chatId` | `isDm` | `isGroupMention` | Effective session key |
|---|---|---|---|---|
| Server channel, bot is `@mentioned` | channel id | `false` | `true` | `discord:<channel-id>` |
| Server thread, bot is `@mentioned` | parent channel id | `false` | `true` | `discord:<channel-id>` (collapses with the parent channel — `threadId` routing is on the [parity plan](../discord.md#whats-shipped-vs-in-flight)) |
| Server channel, no mention | channel id | `false` | `false` | dropped under `mention_only` (the default mode) — see [step 4a](#4a-set-the-default-channel-mode) |
| DM | DM channel id | `true` | `false` | `discord:<channel-id>` |

The adapter strips the `<@botId>` prefix before passing text to the agent, so `@Ethos summarise the channel` arrives as `summarise the channel`.

### 4a. Set the default channel mode

What the bot does with a guild message nobody addressed to it is one key. Discord is single-bot — the token is the top-level `discordToken` — so the mode is top-level too, not an indexed roster entry the way Telegram's and Slack's are:

```yaml
# ~/.ethos/config.yaml
discord.defaultChannelMode: observe
```

Four values, and they apply to every channel the bot can see:

| Mode | Replies to | Records |
|---|---|---|
| `mention_only` (default) | messages that `@mention` the bot | those messages |
| `thread_follow` | mentions, plus every message in a thread the bot has posted in | those messages |
| `all` | every message in the channel | every message |
| `observe` | nothing, not even an explicit `@mention` | every message |

DMs are answered under every mode. An out-of-range value is a parse error — `ethos gateway` prints `discord: invalid defaultChannelMode '<value>'` and exits non-zero rather than falling back. Restart the gateway after editing; the key is read at startup.

`all` is rarely what you want on a busy server: Discord rate limits scale per channel, and Ethos has no per-[personality](../../getting-started/glossary.md#personality) cost cap that limits guild-wide replies.

Nothing extra is needed on the Discord side. The **Message Content Intent** from [step 3](../discord.md#3-confirm-intents) is what makes message text visible at all, and it covers unaddressed messages as much as mentions — unlike Slack, which needs a separate `message.channels` subscription, and Telegram, which needs Group Privacy off.

**There is no per-channel command on Discord.** Slack's `/ethos channel-mode` has no Discord equivalent, so this key is the only way to set a mode today and it cannot be narrowed to one channel. `/ethos help` prints the channel's effective mode read-only. Field details are in [`discord.defaultChannelMode`](../../using/reference/config-yaml.md#discord-default-channel-mode).

## Verify

Run the checks in [Verify](../discord.md#verify).

## Troubleshoot

See [Troubleshoot](../discord.md#troubleshoot).
