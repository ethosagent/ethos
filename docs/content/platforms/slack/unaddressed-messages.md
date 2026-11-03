---
title: "Slack adapter: unaddressed channel messages"
description: "Slack app prerequisites for messages the bot was not addressed in."
kind: how-to
audience: shared
time: "5 min"
updated: 2026-11-03
---

## Task

Match the Slack app's Event Subscriptions to the channel modes you intend to use.

## Result

- The app is subscribed to the events the channel modes you intend to use need.

## Prereqs

- The earlier steps on [Slack adapter](../slack.md) are done.

## Steps

### 1a. Platform prerequisites for unaddressed channel messages

Slack delivers an app only the events that app subscribed to, and delivers nothing at all to say a subscription is missing. An app subscribed to `app_mention` and `message.im` alone hears mentions and DMs perfectly and is deaf to everything else in a channel — which is exactly right until a channel is set to a mode that reads messages nobody addressed to the bot.

Two things gate that, and both are on the Slack side:

| Requirement | Where | Covers |
|---|---|---|
| `message.channels` event subscription | **Event Subscriptions** → **Subscribe to bot events** | Messages in public channels |
| `message.groups` event subscription | same | Messages in private channels |
| `channels:history` bot scope | **OAuth & Permissions** → **Bot Token Scopes** | Reading public-channel message content |
| `groups:history` bot scope | same | Reading private-channel message content |
| Bot is a member of the channel | Invite the bot in Slack | Both — the events follow membership |

The scopes are already in [step 1](../slack.md#1-create-the-slack-app); the two `message.*` subscriptions are the pair most often left off, because mentions and DMs work without them.

Slack grants a `message.*` subscription only when the matching `*:history` scope is already on the app. Adding the scope is what forces a reinstall, and reinstalling issues a new bot token — update `slackBotToken` in `~/.ethos/config.yaml` afterwards.

Read a channel's current mode from inside it:

```
/ethos channel-mode
```

```
Channel mode: mention_only
#build-updates currently uses mention_only (app default).
Set with: /ethos channel-mode all, /ethos channel-mode thread_follow, /ethos channel-mode mention_only, or /ethos channel-mode observe (records every message, never replies).
```

`/ethos channel-mode <mode>` sets it, and the setting is a per-channel override on top of the app default. Set that app-wide default with [`slack.apps.<i>.defaultChannelMode`](../../using/reference/config-yaml.md#slack-apps) — the same four values, `mention_only` when the key is absent, read at gateway startup. `mention_only` is the default and needs neither subscription; `thread_follow`, `all`, and `observe` all read messages the bot was not addressed in, and all need `message.channels` (public) or `message.groups` (private) for the channel in question. `observe` additionally never replies — the bot reads the channel and says nothing in it.

Silence under `observe` covers every surface, not only replies to messages:

| Surface | Under `observe` |
|---|---|
| Messages and `@mentions` | Recorded to the transcript, never answered, no receipt reaction |
| The greeting the bot posts when you invite it | Not posted |
| Unfurling an Ethos link someone pastes | Not unfurled |
| `/ethos ask` | Refused, with a reply only the person who ran it can see |
| A DM to the bot | Answered normally — a DM is not a room |

To ask this bot something while a channel is observed, DM it or change the mode. The DM answers even when `defaultChannelMode: observe` makes `observe` the mode a DM resolves to: there is no third party in a one-to-one conversation for the mode to be protecting, so `link_shared` unfurls and `/ethos ask` work there too.

A stored mode this build cannot read is stricter than `observe`: nothing reaches the room, and nothing is recorded either. Three things produce one — a typo such as `obserev`, a mode a newer Ethos wrote into the same override file, and a mode that is real on a different platform (`regex_match` is Telegram's; Slack has no such mode, so a line copied from a Telegram override file is unreadable here). If a channel has gone quiet unexpectedly, run `/ethos channel-mode`, which prints the stored string verbatim rather than the default it is not. `/ethos help`, the App Home tab, and the `/ethos ask` refusal show the same value.

Only users on the `/ethos` allowlist can run this; see [step 5a](routing-and-access.md#5a-restrict-who-can-run-ethos-and-open-app-home).

## Verify

Run the checks in [Verify](../slack.md#verify).

## Troubleshoot

See [Troubleshoot](../slack.md#troubleshoot).
