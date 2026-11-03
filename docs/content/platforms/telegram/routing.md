---
title: "Telegram adapter: routing and group messages"
description: "Route Telegram chats, replies and group mentions to sessions; group prerequisites."
kind: how-to
audience: shared
time: "5 min"
updated: 2026-11-03
---

## Task

Route Telegram private chats, replies and group `@mentions` to the right session.

## Result

- Private chats, replies, and `@mentions` in groups land in the correct session; everything else is dropped.

## Prereqs

- The earlier steps on [Telegram adapter](../telegram.md) are done.

## Steps

### 3. Understand routing

`TelegramAdapter.start()` registers a `bot.on('message')` listener and forwards every text or caption as an `InboundMessage`. The gateway keys each session per `(platform, botKey, chatId)`. `botKey` is the `id` field from config (or its sha256-derived default).

In **single-bot** mode (legacy `telegramToken` scalar), the session key omits the bot segment:

| Chat type | `chatId` | `isDm` | `isGroupMention` | Effective session key |
|---|---|---|---|---|
| Private chat | user id | `true` | `false` | `telegram:<user-id>` |
| Group (bot is `@mentioned`) | negative group id | `false` | `true` | `telegram:<group-id>` |
| Group (reply to bot) | negative group id | `false` | `false` | `telegram:<group-id>` |
| Group (random chatter) | negative group id | `false` | `false` | dropped by the mention gate |

With [`telegram.bots.<i>.mentionByName: true`](../../using/reference/config-yaml.md#mention-by-name), a group message that names the bound personality as a whole word ("hey Owl, …") also sets `isGroupMention: true`. It gets a receipt reaction only when the chat's mode would have answered it without the name. The receipt reaction is the personality's [`display.emoji`](../../using/reference/personality-yaml.md#display) when Telegram accepts it as a reaction, else 👀.

The last row assumes Telegram delivered the message at all. With BotFather's Group Privacy on — the default for every new bot — it does not: unaddressed group posts never reach the adapter, so the mention gate never sees them. [Platform prerequisites for group messages](#3b-platform-prerequisites-for-group-messages) covers the difference and how to check which side of it a bot is on.

In **multi-bot** mode (`telegram.bots` list), the session key includes the `botKey` segment — `telegram:<botKey>:<chatId>` — so each bot maintains fully isolated histories even when the same Telegram user id appears in both bots' chats.

The session key forks when `/new` or `/personality <id>` runs in the chat — both append `:${Date.now()}` so the agent loses prior context cleanly. The previous session's outbound dedup keys are cleared at the same boundary.

Group chats share one session across every member. To give each user their own thread, deploy two bots and `/start` them privately. A group turn never reads or writes the personality's private memory (`MEMORY.md`, `USER.md`) unless the group is listed under `gateway.private_chats.telegram` — see [Keep memory out of group chats](../../using/how-to/group-chat-memory.md).

### 3a. Plugin commands

Plugin commands registered via `registerSlashCommand()` appear in Telegram's command menu. The gateway calls `registerCommands()` at startup, which pushes the command list to the Telegram Bot API via `setMyCommands`. Command names are sanitized to Telegram's constraints: lowercase, underscores only, max 32 characters.

Commands are dispatched via the gateway's text-matching pipeline — the same path as built-in `/` commands. In a group, Telegram's menu sends a command addressed to one bot, `/new@your_bot`. The gateway reads a command addressed to its own `@username` as the plain command, so arguments still follow it (`/branch@your_bot 2`). It ignores a command addressed to another bot, `/new@other_bot`: no reply and no agent turn (`commandForThisBot` in `extensions/gateway/src/index.ts`). See [Register plugin slash commands](../../building/how-to/register-plugin-commands.md) for the full walkthrough.

### 3b. Platform prerequisites for group messages

Telegram decides what a bot in a group is allowed to see, and it decides it in BotFather. No Ethos setting overrides it.

Every bot is created with **Group Privacy on**. Telegram then delivers only the group messages that mention the bot by `@username`, reply to one of its messages, or are commands. Ordinary chatter between other members never leaves Telegram's servers, so no amount of gateway configuration can reach it.

That default matches the routing in [step 3](#3-understand-routing): Ethos answers Telegram groups on mention or reply, and privacy on is the narrower, safer setting for a bot that only ever answers when spoken to. Turn it off only when the bot has a reason to read messages addressed to nobody — the bot then receives every message in every group it belongs to, which is a real privacy decision to take deliberately rather than as setup boilerplate.

**Check which side a bot is on.** Ask Telegram rather than BotFather's menus:

```bash
curl -s "https://api.telegram.org/bot<your-bot-token>/getMe"
```

```json
{"ok":true,"result":{"id":123456789,"is_bot":true,"first_name":"My Strategist Bot","username":"my_strategist_bot","can_join_groups":true,"can_read_all_group_messages":false,"supports_inline_queries":false}}
```

`can_read_all_group_messages` is the answer, and it is inverted from the BotFather wording: `false` means privacy mode is **on** and the bot sees only what is addressed to it. `true` means privacy mode is off and the bot reads the whole group.

**Turn privacy mode off.**

1. Open `@BotFather` and send `/setprivacy`.
2. Pick the bot.
3. Choose **Disable**.
4. Remove the bot from every group it already belongs to, then add it back.

Step 4 is the one that gets missed. Telegram fixes a bot's privacy setting per group at the moment the bot joins, so a bot already sitting in a group keeps the setting it joined under. `getMe` will report `can_read_all_group_messages: true` while that group still behaves as though privacy were on — the setting is right and the group is stale. Re-adding the bot is what reconciles them.

**Set what the bot does with what it hears.** Privacy mode decides what Telegram delivers; `telegram.bots.<i>.defaultChannelMode` decides what the bot does with it. Turning privacy mode off alone changes nothing about replies — the default mode is still `mention_only`, so unaddressed messages arrive and are dropped.

```yaml
# ~/.ethos/config.yaml
telegram.bots.0.defaultChannelMode: observe
```

Five values, and they apply to every group the bot is in:

| Mode | Replies to | Records |
|---|---|---|
| `mention_only` (default) | messages containing the bot's `@username` | those messages |
| `thread_follow` | mentions, plus every message in a forum topic the bot has posted in | those messages |
| `all` | every message in the chat | every message |
| `regex_match` | mentions only, in practice — see below | those messages |
| `observe` | nothing, not even an explicit `@mention` | every message |

DMs are answered under every mode. `regex_match` matches a per-chat stored pattern, and there is no way to store one on Telegram yet, so as a global default it behaves as `mention_only`. Restart the gateway after editing the key — config is read at startup.

A bot left on `observe` while privacy mode is still on records nothing, and says so at boot: `Telegram privacy mode is ON for @<username> — chats set to observe will record nothing.` Fix it with the BotFather sequence above, re-add included.

**There is no per-chat command on Telegram.** Slack's `/ethos channel-mode` has no Telegram equivalent, so this key is the only way to set a mode today and it cannot be narrowed to one group. Field details are in [`telegram.bots.*`](../../using/reference/config-yaml.md#telegram-bots).

## Verify

Run the checks in [Verify](../telegram.md#verify).

## Troubleshoot

See [Troubleshoot](../telegram.md#troubleshoot).
