---
title: "Least-privilege tokens: Slack, Telegram and Discord"
description: "Minimal scopes for Slack, Telegram and Discord bot tokens."
kind: how-to
audience: shared
time: "10 min"
updated: 2026-11-03
---

## Task

Mint minimally scoped tokens for the Slack, Telegram and Discord channel adapters.

## Result

Every step on this page is applied and the checks in [Verify](../least-privilege-tokens.md#verify) on the main page pass.

## Prereqs

Complete the [Prereqs](../least-privilege-tokens.md#prereqs) listed on the main page, [Least-privilege token cookbook](../least-privilege-tokens.md).

## Steps

### 1. Slack

Slack uses OAuth scopes on two token types: a **Bot Token** (starts with `xoxb-`) and an **App-Level Token** (starts with `xapp-`).

#### Bot token scopes

Request only the scopes the agent needs. Start with this baseline and add scopes one at a time:

| Scope | Purpose | Required? |
|---|---|---|
| `channels:read` | List public channels the bot is in | Yes |
| `channels:history` | Read messages in public channels | Yes |
| `chat:write` | Send messages | Yes |
| `users:read` | Resolve user display names | Yes |
| `reactions:write` | Add emoji reactions (acknowledgements, status) | Recommended |
| `app_mentions:read` | Receive `app_mention` events (mention-gated bots) | If using mention gate |

Do **not** add `channels:manage`, `admin.*`, `files:write`, or any scope prefixed with `groups:` unless the personality's toolset explicitly requires private-channel or admin operations.

#### App-level token (Socket Mode)

1. Go to **https://api.slack.com/apps/{YOUR_APP_ID}/general**.
2. Enable **Socket Mode**.
3. Generate an App-Level Token with the single scope `connections:write`.

Socket Mode avoids exposing a public HTTP endpoint, but it does not replace the signing secret. Always configure the signing secret in `~/.ethos/config.yaml` even when using Socket Mode -- Ethos validates it on every inbound event regardless of transport.

#### Verify

```bash
# List the scopes on your bot token (requires curl + jq)
curl -s -H "Authorization: Bearer xoxb-YOUR-TOKEN" \
  https://slack.com/api/auth.test | jq '.response_metadata.scopes'
```

Confirm the returned list matches the table above and nothing more.

### 2. Telegram

Telegram bot tokens are all-or-nothing. BotFather issues a single token with full bot permissions -- there is no scope system.

#### Create the token

1. Open a chat with [@BotFather](https://t.me/BotFather) on Telegram.
2. Send `/newbot` and follow the prompts.
3. Copy the token BotFather returns.

#### Mitigations

Since Telegram offers no per-scope restriction, apply these compensating controls:

1. **Sender allowlist.** Configure `channel_filter` in `config.yaml` to restrict which Telegram user IDs or chat IDs the agent responds to. Ethos drops messages from unlisted senders at the channel layer before they reach the agent loop.
2. **Disable group joins.** Send `/setjoingroups` to BotFather and select **Disable**. This prevents anyone from adding the bot to arbitrary groups.
3. **Disable inline mode.** Send `/setinline` to BotFather and leave inline mode off unless the personality requires it.

#### Verify

Send a message from a non-allowlisted account. Confirm the agent does not respond (a DM gets a pairing code instead) and that `observability.db` logs an `audit.block` event with code `channel.allowlist.blocked` (DM) or `channel.mention_gate` (group).

### 3. Discord

Discord uses a permissions integer -- a single number encoding a bitfield of allowed actions.

#### Minimum permissions

| Permission | Bit | Hex | Purpose |
|---|---|---|---|
| `VIEW_CHANNEL` | 10 | `0x400` | See channels the bot is added to |
| `SEND_MESSAGES` | 11 | `0x800` | Post messages |
| `READ_MESSAGE_HISTORY` | 16 | `0x10000` | Read past messages for context |
| `MESSAGE_CONTENT` | 15 | `0x8000` | Access message text (privileged intent) |

#### Calculate the permissions integer

OR the hex values together:

```
0x400 | 0x800 | 0x10000 | 0x8000 = 0x19C00
```

In decimal: **104448**. Use this value when generating the OAuth2 invite URL:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=104448
```

Do **not** use `8` (Administrator) or `70368744177655` (all permissions). These are the Discord equivalent of `root`.

#### Privileged intents

`MESSAGE_CONTENT` is a privileged intent. Discord requires explicit approval in the Developer Portal for bots in 100 or more servers. Enable it under **Bot > Privileged Gateway Intents** before scaling. For bots under 100 servers, toggle it on in the portal -- no approval form needed.

#### Verify

1. Open the Discord Developer Portal at **https://discord.com/developers/applications/{APP_ID}/bot**.
2. Confirm **Privileged Gateway Intents** shows only `MESSAGE_CONTENT` enabled (and `SERVER_MEMBERS` or `PRESENCE` only if the personality needs them).
3. Check the bot's role in your server -- it should have no additional permissions beyond what the invite URL granted.

## Verify

Run the [Verify](../least-privilege-tokens.md#verify) steps on the main page once all parts are done.

## Troubleshoot

A scope-error response from a provider means the token is too narrow. Widen only the specific scope that failed; see [Verify](../least-privilege-tokens.md#verify).
