---
title: "config.yaml: per-bot settings"
description: "config.yaml per-bot budget, reply prefix and mention keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Settings that apply to each configured bot. Part of the [config.yaml reference](../config-yaml.md).

## \<bot\>.budget.dailyUsd {#bot-daily-budget}

Type: positive number (USD) · Default: unset (no daily cap)

Caps what one channel bot may spend per UTC day. Set it on the bot's own entry: `telegram.bots.<i>.budget.dailyUsd`, `slack.apps.<i>.budget.dailyUsd` or `whatsapp.<i>.budget.dailyUsd`.

```yaml
telegram.bots.0.budget.dailyUsd: 5
```

Notes:

- Once the bot's spend since 00:00 UTC meets the cap, each new message gets one reply saying so, and no agent turn runs until the next UTC day. `Gateway.enqueueTurn` in [`extensions/gateway/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/gateway/src/index.ts) enforces it.
- Spend is the same figure `ethos usage` reports, narrowed to that bot's sessions. The gateway reads it at most once a minute and adds its own turns' costs in between. Tool-reported costs are not in that figure, so they do not count toward this cap.
- `/budget` in a chat shows the bot's spend today against this cap, next to the session cap. `/budget reset` clears only the session cap, never this one.
- A value that is not a positive number is a parse error, and the bot entry is dropped. The legacy scalar bots (`telegramToken`, `discordToken`, email) have no entry to hold it, so they cannot be capped this way.
- If the spend cannot be read, the turn runs, and the gateway records a `gateway.daily_budget_unreadable` event.
- This is an operator setting, not part of a personality: two deployments of the same personality can set different caps. The per-session cap is [`budgetCapUsd`](../personality-yaml.md#budget-cap-usd).

## \<bot\>.replyPrefix {#reply-prefix}

Type: string template · Default: unset (replies unchanged)

Text the gateway puts in front of every reply the bot sends, filled from the personality bound to the chat. Set it on the bot's own entry: `telegram.bots.<i>.replyPrefix`, `slack.apps.<i>.replyPrefix`, or the top-level `discord.replyPrefix` (Discord is single-bot).

| Placeholder | Filled with |
|---|---|
| `{name}` | The bound personality's `name` (its id when it has none). Follows a `/personality` switch. |
| `{emoji}` | The bound personality's [`display.emoji`](../personality-yaml.md#display). |

```yaml
telegram.bots.0.replyPrefix: "{emoji} {name}: "
discord.replyPrefix: "[{name}] "
```

With `display.emoji: 🦉` and `name: Owl`, the first line renders `🦉 Owl: ` in front of the reply.

Notes:

- These are the only two placeholders. Any other text is copied as written, and a value is never re-scanned for placeholders.
- A placeholder with no value is removed with one adjacent space, so `"{emoji} {name}: "` for a personality with no emoji renders `Owl: `, not ` Owl: `.
- Quote a value that ends in a space. Unquoted, the trailing space is lost.
- When a reply opens with a markdown block (a heading, a list item, a block quote, a code fence), the prefix is trimmed and put on its own line, so the block still renders.
- The prefix is part of the reply's content. The gateway applies it before outbound dedup and before the delivery ledger records the reply, so a redelivery sends the stored text as-is and nothing is prefixed twice. A streamed reply carries it in the first chunk and in the final edit. Adapters never add it. `applyReplyPrefix` in [`extensions/gateway/src/reply-prefix.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/gateway/src/reply-prefix.ts); pinned by `extensions/gateway/src/__tests__/reply-prefix.test.ts`.
- Gateway notices (errors, empty-reply notices, credential links) and the spoken text of a voice note get no prefix.
- This is an operator setting, not a personality field: two deployments of the same personality can prefix differently.

## \<bot\>.mentionByName {#mention-by-name}

Type: boolean · Default: `false`

Count a group message that names the bound personality as a mention of the bot, exactly like an `@mention`. Set it on `telegram.bots.<i>.mentionByName`, `slack.apps.<i>.mentionByName` or the top-level `discord.mentionByName`.

```yaml
telegram.bots.0.mentionByName: true
```

Notes:

- The match is a whole word, case-insensitive, on the personality's `name`: with `name: Owl`, "hey Owl, can you check this?" counts and "Owlish" does not. Regex characters in the name are matched literally, and composed and decomposed accents match each other. `mentionsPersonalityName` in [`packages/core/src/channel-presence.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/channel-presence.ts); pinned by `packages/core/src/__tests__/channel-presence.test.ts`.
- A match sets `InboundMessage.isGroupMention`. The channel filter is unchanged, so a member the filter does not allow is still dropped.
- Direct messages never need it.
- A message that reaches the bot only by naming it gets no receipt reaction on Slack and Discord. On Telegram it gets one only when the chat's mode would have answered it without the name.

## Receipt reaction {#receipt-reaction}

The emoji a channel bot reacts with when a message arrives, cleared when the reply lands. It is chosen in this order: an explicitly configured receipt reaction, then the bound personality's [`display.emoji`](../personality-yaml.md#display), then the platform default.

| Platform | Configured by | Personality emoji used when | Default |
|---|---|---|---|
| Slack | [`slack.apps.<i>.receiptReaction`](telegram-slack-teams.md#slack-apps) | Its Slack emoji name is in the adapter's table (`slackEmojiName`, `extensions/platform-slack/src/adapter.ts`) | `eyes` (👀) |
| Telegram | Not a `config.yaml` key | Telegram's Bot API accepts it as a reaction (`telegramReceiptEmoji`, `extensions/platform-telegram/src/index.ts`) | 👀 |
| Discord | Not a `config.yaml` key | Always (Discord takes any unicode emoji) | 👀 |

Notes:

- If the platform refuses the personality's emoji (a Telegram chat can narrow its allowed reactions), the adapter retries once with the default. The reaction is never dropped for the personality's sake.
- With no `display.emoji` and no configured reaction, every platform reacts exactly as before.

## gateway.private\_chats.\<platform\> {#gateway-private-chats}

Type: comma-separated chat ids · Default: unset (no trusted rooms)

Group chats on `<platform>` that the operator vouches for as private (trusted rooms). A listed room is treated like a direct message when the gateway decides a turn's room audience: its turns read and write the personality's private memory, and the memory tools come back. An unlisted group never does. See [Keep memory out of group chats](../../how-to/group-chat-memory.md).

```yaml
gateway.private_chats.telegram: -1001234567890,-1009876543210
gateway.private_chats.slack: C0123TEAM
```

| Part | Meaning |
|---|---|
| `<platform>` | The platform id the chat id belongs to: `telegram`, `slack`, `discord`, `whatsapp`, `email`, or a plugin platform's id. |
| value | The platform's own chat ids, exactly as the adapter reports them: a negative Telegram group id, a Slack channel id, a WhatsApp `@g.us` JID. |

Notes:

- Read by `Gateway.audienceFor` in [`extensions/gateway/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/gateway/src/index.ts), which receives it as `GatewayConfig.privateChats` from `buildGateway` in [`apps/ethos/src/commands/gateway.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/gateway.ts).
- A thread or topic inside a listed chat is private too. Listing a thread id alone does nothing: the check reads the parent chat id.
- A chat whose session already ran shared stays shared after you list it. Send `/new` in the chat to start a session that follows the list.
- The list is keyed on platform and chat id only. Every bot on that platform honours it.
- It has no filter side effects. Unlike a `channel_filter.<platform>` block, listing a room does not turn on the sender allowlist, pairing or mention gating.
- Read once at gateway startup, by `ethos gateway start` and `ethos boot`. Restart the gateway after editing. An edit made while the gateway runs is logged as `gateway.private_chats changed — restart required to apply`.
- A room you remove from the list stays trusted until that restart.
- Ids are trimmed and de-duplicated. An id containing whitespace, or an entry that lists no ids, is dropped with a startup warning. A warning never stops startup.
- A misspelt platform matches no chat, so the room stays shared.
- The web UI's config saves keep this key untouched.

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
