---
title: "config.yaml: Telegram, Slack and Teams keys"
description: "config.yaml Telegram bot, Slack app and team roster keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys that register Telegram bots, Slack apps and team rosters. Part of the [config.yaml reference](../config-yaml.md).

## telegram.bots.\* {#telegram-bots}

Multi-bot list shape. When set, the gateway creates one `TelegramAdapter` and one `AgentLoop` per entry. `telegram.bots` takes precedence over the legacy `telegramToken` scalar when both are present.

| Field | Type | Default | Description |
|---|---|---|---|
| `telegram.bots.<i>.token` | string | — | Bot token from BotFather. Required per entry. |
| `telegram.bots.<i>.id` | string | `sha256(token)[:24]` | Stable, human-readable bot key. Used in session lane names (`telegram:<botKey>:<chatId>`), log output, and the internal `Map<botKey, AgentLoop>`. Set once; do not change after the bot goes live. |
| `telegram.bots.<i>.bind.type` | `personality` \| `team` | — | Required. `personality` routes to a named personality. `team` routes to the team's coordinator personality and auto-starts the team supervisor. |
| `telegram.bots.<i>.bind.name` | string | — | Required. Personality id (for `personality`) or team name (for `team`). |
| `telegram.bots.<i>.bind.allowSlashSwitch` | boolean | `false` | Allow per-chat `/personality` switching. Disabled by default for identity-bound bots. In a group chat only `channel_filter.telegram.ownerUserId` may switch; a group with no owner configured refuses. |
| `telegram.bots.<i>.defaultChannelMode` | `mention_only` \| `thread_follow` \| `all` \| `regex_match` \| `observe` | `mention_only` | Reply-and-record behaviour in group chats that have no per-chat override. Five values — one more than Slack's four; see the mode list below. Every value except `mention_only` acts on group messages nobody addressed to the bot, and Telegram delivers those only when BotFather's Group Privacy is off — see [Platform prerequisites for group messages](../../../platforms/telegram.md#3b-platform-prerequisites-for-group-messages). An out-of-range value is a parse error, not a silent fallback. |
| `telegram.bots.<i>.useWebhook` | boolean | `false` | Receive updates over an inbound webhook instead of long-polling. Requires `webhookUrl` and `webhookSecretToken` — the adapter throws at startup without either. See [Receive Slack and Telegram events over webhooks](../../how-to/run-channels-over-webhooks.md). |
| `telegram.bots.<i>.webhookUrl` | string | — | Required when `useWebhook` is `true`. The full public URL Telegram POSTs updates to, **including** the `/telegram/webhook/<botKey>` path — the host routes on that path, so a URL without it reaches no handler. Registered for you by `setWebhook()` at startup. |
| `telegram.bots.<i>.webhookSecretToken` | string | — | Required when `useWebhook` is `true`. Echoed by Telegram in `X-Telegram-Bot-Api-Secret-Token` and compared by grammy before the update is processed. A credential: externalized to the secret vault exactly like `token`, so write it as `${secrets:<ref>}`. |
| `telegram.bots.<i>.dropPendingUpdates` | boolean | `false` | Discard updates Telegram queued while the process was down. With the default, messages sent during a restart are answered once the bot is back. **Poll mode only** — `bot.start()` is never called for a webhook-mode bot, so the flag does nothing there. Set `true` only if a restart should skip everything queued while the bot was down. |
| `telegram.bots.<i>.replyPrefix` | string | unset | Template put in front of every reply, with `{name}` and `{emoji}` from the bound personality. See [`<bot>.replyPrefix`](bot-settings.md#reply-prefix). |
| `telegram.bots.<i>.mentionByName` | boolean | `false` | Count a group message that names the bound personality as a mention. See [`<bot>.mentionByName`](bot-settings.md#mention-by-name). |

```yaml
telegram.bots.0.token: "123456:ABCdefGhIJklmNopQRstuVwxYZ"
telegram.bots.0.id: researcher-bot
telegram.bots.0.bind.type: personality
telegram.bots.0.bind.name: researcher

telegram.bots.1.token: "654321:XYZabcDeFgHijKlMnOpqRsTuV"
telegram.bots.1.id: coder-bot
telegram.bots.1.bind.type: personality
telegram.bots.1.bind.name: engineer
```

Notes:

- `defaultChannelMode` values, as `evaluateChannelMode()` in [`packages/core/src/channel-mode.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/channel-mode.ts) resolves them:
  - `mention_only` — reply only when the message contains the bot's `@username` (default).
  - `thread_follow` — `mention_only`, plus every message in a forum topic the bot has already posted in.
  - `all` — reply to every message in the chat.
  - `regex_match` — `mention_only`, plus messages matching a per-chat stored pattern. **No effect as a global default:** the pattern is read from a per-chat override, and Telegram has no way to write one yet (see the bullet below), so a message that is not a mention never matches.
  - `observe` — record every message to the channel transcript and reply to none of them, not even an explicit `@mention`. Direct messages to the bot are answered under every mode, `observe` included.
  - **An unrecognised mode fails closed — not answered, not recorded.** It cannot reach the evaluator from this key (an out-of-range value here is a parse error, per the table above), but it can from the per-chat override store on disk — a hand-edited entry, or a mode written by a newer build and read by an older one. `evaluateChannelMode()` drops those before every other test rather than falling back to `mention_only`; the affected chat goes silent. Direct messages are still answered, which is the channel left to notice it through.
- **Per-chat overrides cannot be set on Telegram yet.** The adapter reads a per-chat override store (`ChannelOverrideStore`, JSONL under the bot's `telegram/<botKey>/` directory) and a stored entry wins over this key, but no command or API writes one — Slack's `/ethos channel-mode` has no Telegram equivalent. This key is the only way to put a Telegram chat into `observe` today, and it applies to every group the bot is in.
- A bot whose resolved mode is `observe` while BotFather's Group Privacy is still on records nothing at all. The adapter checks `getMe` at startup and logs `Telegram privacy mode is ON for @<username> — chats set to observe will record nothing.` rather than leaving an empty transcript to explain itself.
- Session key format in multi-bot mode: `telegram:<botKey>:<chatId>`. This differs from single-bot mode (`telegram:<chatId>`).
- `deriveBotKey()` in [`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts) computes the sha256-derived default when `id` is omitted.
- See [Run multiple Telegram bots from one process](../../how-to/run-multi-bot-telegram.md) for a full walkthrough.

## telegramToken {#telegram-token}

Type: string · Default: unset · **Deprecated** (use `telegram.bots` instead)

Legacy scalar shape — wires one bot bound to the default `personality`. Still supported; creates a single-element entry in the gateway's internal bot list. When both `telegramToken` and `telegram.bots` are set, `telegram.bots` takes precedence and this field is ignored with a deprecation warning.

```yaml
telegramToken: 123456:ABC-DEF...
```

## slack.apps.\* {#slack-apps}

Multi-app list shape for Slack. Each entry creates one Slack adapter bound to a personality or team. Supersedes the legacy scalar fields `slackBotToken`, `slackAppToken`, and `slackSigningSecret` when set.

| Field | Type | Default | Description |
|---|---|---|---|
| `slack.apps.<i>.botToken` | string | — | `xoxb-` bot token. Required per entry. |
| `slack.apps.<i>.appToken` | string | — | `xapp-` app-level token for Socket Mode. Required only while `mode.socket` is in effect (the default); an HTTP-mode app has no Socket Mode connection and needs none. The adapter throws when `mode.socket` is on and this is absent. |
| `slack.apps.<i>.signingSecret` | string | — | Signing secret from the app's Basic Information page. Required per entry. Exercised only under `mode.http`, where it is the HMAC key every inbound Events API request is verified against; under Socket Mode it is carried but never used — the socket is authenticated by `appToken` and receives no HTTP requests to verify. |
| `slack.apps.<i>.mode.socket` | boolean | `true` | Connect over Socket Mode (WebSocket). Mutually exclusive with `mode.http` — the adapter throws when both are `true`, because they are two transports for the same inbound event stream. |
| `slack.apps.<i>.mode.http` | boolean | `false` | Receive Events API deliveries over inbound HTTP instead. Requires `signingSecret`, and requires setting `mode.socket: false` explicitly. Slack has no registration API: you must set the Event Subscriptions Request URL in the Slack app dashboard yourself. See [Receive Slack and Telegram events over webhooks](../../how-to/run-channels-over-webhooks.md). |
| `slack.apps.<i>.webhookPath` | string | the app's `botKey` | Route segment this app's HTTP receiver answers on, under `/slack/events/`. HTTP mode only. Leading and trailing slashes are stripped. |
| `slack.apps.<i>.id` | string | `sha256(botToken)[:24]` | Stable, human-readable app key. Used in session lane names and log output. Set once; do not change after the app goes live. |
| `slack.apps.<i>.bind.type` | `personality` \| `team` | — | Required. Same semantics as the Telegram equivalent. |
| `slack.apps.<i>.bind.name` | string | — | Required. Personality id or team name. |
| `slack.apps.<i>.bind.allowSlashSwitch` | boolean | `false` | Allow per-channel `/personality` switching. In a channel only `channel_filter.slack.ownerUserId` may switch; a channel with no owner configured refuses. |
| `slack.apps.<i>.defaultChannelMode` | `mention_only` \| `thread_follow` \| `all` \| `observe` | `mention_only` | Reply-and-record behaviour in channels that have no per-channel override. Four values, not Telegram's five — the Slack adapter has no `regex_match`. `thread_follow` also answers follow-ups in threads the bot has already posted in; `all` answers every message; `observe` records every message and replies to none, not even an explicit `@mention`. DMs are answered under every mode. Anything but `mention_only` needs the `message.channels` / `message.groups` event subscriptions — see [Platform prerequisites for unaddressed channel messages](../../../platforms/slack.md#1a-platform-prerequisites-for-unaddressed-channel-messages). `/ethos channel-mode <mode>` overrides it per channel. An out-of-range value is a parse error, not a silent fallback. |
| `slack.apps.<i>.receiptReaction` | string | unset | Emoji name (no colons) reacted onto an inbound message on arrival and removed once the reply lands. When set, it wins over the bound personality's `display.emoji`; unset, the personality's emoji is used when its Slack name is known, else `eyes`. See [Receipt reaction](bot-settings.md#receipt-reaction). Needs the `reactions:write` scope; without it the reaction is skipped silently. |
| `slack.apps.<i>.replyPrefix` | string | unset | Template put in front of every reply, with `{name}` and `{emoji}` from the bound personality. See [`<bot>.replyPrefix`](bot-settings.md#reply-prefix). |
| `slack.apps.<i>.mentionByName` | boolean | `false` | Count a channel message that names the bound personality as a mention. See [`<bot>.mentionByName`](bot-settings.md#mention-by-name). |
| `slack.apps.<i>.allowedSlashUsers` | string list | unset | Comma-separated Slack user ids allowed to run `/ethos` and to see the App Home tab's memory, session, kanban, and channel sections. Narrows `channel_filter.slack` (`ownerUserId` + `recipientAllowlist`) — an id listed here that is not on that allowlist stays denied. Absent or empty means the `channel_filter.slack` allowlist alone. Both empty means nobody: the gate is default-closed. |
| `slack.apps.<i>.allowedBotIds` | string list | unset | Comma-separated Slack `bot_id`s whose messages reach the agent, in new posts, edits, and thread backfill alike. Absent or empty drops every bot- and workflow-authored message — the gate is default-closed. Read a bot's id from the `bot_id` field of any message it has posted. |
| `slack.apps.<i>.longReplyThresholdChars` | integer | `9000` | Reply length above which the agent posts a short lead message ending in "full answer attached" plus the complete text as an `answer.md` upload, instead of four or more chunked messages. `0` disables the fallback. The upload needs the `files:write` scope; without it the reply falls back to the chunked messages. |

```yaml
slack.apps.0.botToken: "xoxb-..."
slack.apps.0.appToken: "xapp-..."
slack.apps.0.signingSecret: "abc123..."
slack.apps.0.id: eng-slack
slack.apps.0.bind.type: team
slack.apps.0.bind.name: eng
slack.apps.0.allowedBotIds: B01DEPLOYBOT,B02ALERTBOT
```

Notes:

- `/ethos` and the App Home tab are default-deny as of this release, and the trust set comes from `channel_filter.slack` — the same allowlist that decides who may message the bot. A workspace with no `channel_filter.slack.ownerUserId` and no `recipientAllowlist` authorizes nobody: every `/ethos` invocation answers "You are not authorized to use this command," and App Home shows a notice in place of its private sections. **This is a breaking change** — before it, any workspace member could run `/ethos memory add`, which writes the bound personality's `MEMORY.md` into every later system prompt. Set `channel_filter.slack.ownerUserId` to your Slack user id to restore access. `channel_filter.slack.enabled: false` does not reopen these surfaces; it only disables the message filter.
- An allowlisted bot's message carries `userId = <bot_id>`, and the gateway's channel filter allowlists by `userId`. Two gates guard a bot message and both must open: `allowedBotIds` here, plus the same `bot_id` in `channelFilter.slack.recipientAllowlist` (or no filter configured at all). See [Run an agent on Slack](../../../platforms/slack.md) for the filter block. There is no bypass — an operator who opens one gate and forgets the other sees the bot's messages silently dropped at the gateway.
- The same two gates apply to the bot's lines in **thread backfill**, and only under `channel_filter.slack.contextVisibility: allowlist`. Backfilled history is attributed line by line, and each line is checked against `recipientAllowlist` by the same id — a human's Slack user id, a bot's `bot_id`. So an operator running the stricter context-visibility setting who allowlists a bot in `allowedBotIds` but not in `recipientAllowlist` sees its history lines dropped while its live messages are dropped too, consistently. Under the default `contextVisibility: all`, backfill is not filtered at all and `allowedBotIds` alone decides which bots appear in it.

## teams.\* {#teams}

Per-team runtime knobs. These apply to teams that the gateway auto-starts via `bind.type: team` in `telegram.bots` or `slack.apps`.

| Field | Type | Default | Description |
|---|---|---|---|
| `teams.<name>.autoStop` | boolean | `true` | When `true`, the gateway stops the team supervisor when the gateway shuts down. Set to `false` to leave the supervisor running across gateway restarts. |

```yaml
teams.eng.autoStop: false
```

Notes:

- `<name>` must match the team manifest filename stem at `~/.ethos/teams/<name>.yaml`.
- With `autoStop: false`, stop the supervisor manually with `ethos team stop <name>`.
- See [Connect a Telegram bot to a team](../../how-to/connect-telegram-to-team.md) for a usage example.

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
