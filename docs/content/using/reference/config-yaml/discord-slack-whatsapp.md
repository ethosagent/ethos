---
title: "config.yaml: Discord, Slack token and WhatsApp keys"
description: "config.yaml Discord, Slack token and WhatsApp keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys for Discord, the single-app Slack tokens and WhatsApp. Part of the [config.yaml reference](../config-yaml.md).

## discordToken {#discord-token}

Type: string · Default: unset

Bot token for the Discord gateway.

## discord.defaultChannelMode {#discord-default-channel-mode}

Type: `mention_only` | `thread_follow` | `all` | `observe` · Default: `mention_only`

Reply-and-record behaviour in every guild channel that has no per-channel override. Discord is single-bot — its credential is the top-level [`discordToken`](#discord-token) scalar, with no `discord.bots` roster — so this is a **top-level** key, not an indexed entry like [`telegram.bots.<i>.defaultChannelMode`](telegram-slack-teams.md#telegram-bots) or [`slack.apps.<i>.defaultChannelMode`](telegram-slack-teams.md#slack-apps).

- `mention_only` — reply only when the message `@mentions` the bot (default).
- `thread_follow` — `mention_only`, plus every message in a thread the bot has already posted in.
- `all` — reply to every message in the channel.
- `observe` — record every message to the channel transcript and reply to none of them, not even an explicit `@mention`.
- **An unrecognised mode fails closed — not answered, not recorded.** Not reachable from this key, which is validated at parse (below), but reachable from a per-channel override written by hand or by a newer build. `evaluateChannelMode()` drops those before every other test rather than falling back to `mention_only`. Direct messages are still answered.

```yaml
discord.defaultChannelMode: observe
```

Notes:

- Four values, not Telegram's five — the Discord adapter has no `regex_match`. DMs are answered under every mode, `observe` included. An out-of-range value is a parse error, not a silent fallback: `ethos gateway` and `ethos boot` print `discord: invalid defaultChannelMode '<value>'` and exit non-zero.
- Read once at gateway startup. Restart the gateway after editing.
- Unlike Slack and Telegram, Discord needs no extra platform-side switch for messages nobody addressed to the bot. The **Message Content Intent** the adapter already requires for mentions covers them too — see [Confirm intents](../../../platforms/discord.md#3-confirm-intents).
- **Per-channel overrides cannot be set on Discord.** The adapter reads a per-channel override store (`ChannelOverrideStore`, JSONL under `~/.ethos/discord/<botKey>/`) and a stored entry wins over this key, but no command or API writes one — Slack's `/ethos channel-mode` has no Discord equivalent. This key is the only way to put a Discord channel into `observe` today, and it applies to every channel the bot can see. `/ethos help` prints the channel's effective mode.

## discord.approvalRoleIds {#discord-approval-role-ids}

Type: comma-separated list of Discord role ids · Default: unset

Roles whose members may click **Approve** / **Deny** on a Discord approval card. Unset, the adapter refuses every click with "Approval roles not configured. No one can approve." (`DiscordAdapter.handleApprovalDecision` in [extensions/platform-discord/src/index.ts](https://github.com/ethosagent/ethos/blob/main/extensions/platform-discord/src/index.ts)), and each approval is denied when its timeout expires.

```yaml
discord.approvalRoleIds: 1234567890123456789,9876543210987654321
```

Notes:

- A role check comes first. The approval coordinator then accepts only the bound decider: the requester in a DM, the platform owner in a group.
- Read once at gateway startup. Restart the gateway after editing.

## discord.post_thinking_placeholder {#discord-post-thinking-placeholder}

Type: boolean · Default: `true`

The "Thinking…" placeholder message the Discord adapter posts while a turn runs, so a channel is not silent between the user's message and the reply. `false` disables it — no placeholder is posted, and the reply arrives as the first message. Parsed into `EthosConfig.discordPostThinkingPlaceholder` ([`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts)); a value that is neither `true` nor `false` is dropped and reads as unset.

```yaml
discord.post_thinking_placeholder: false
```

Notes:

- Read once at gateway startup. Restart the gateway after editing.

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

## whatsapp.\<i\>.default_mode {#whatsapp-default-mode}

Type: `all` | `mention_only` | `observe` · Default: `mention_only`

Reply-and-record behaviour in the group chats of the WhatsApp account at index `<i>` that have no per-chat override. Note the key name: `default_mode`, snake_case — not `defaultChannelMode`. The whole `whatsapp.<i>.*` block is snake_case (`session_dir`, `allowed_numbers`, `phone_number`), and this key follows its own block rather than the other three platforms. It is the real key, not a typo.

- `all` — reply to every message in the group.
- `mention_only` — reply only when the message mentions the bot (default).
- `observe` — record every message to the channel transcript and reply to none of them, not even an explicit mention.

```yaml
whatsapp.0.default_mode: observe
```

Notes:

- Three values — the smallest of the four adapters' sets. WhatsApp has no threads, so no `thread_follow`, and no `regex_match`. Direct chats are answered under every mode, `observe` included. An out-of-range value is a parse error, not a silent fallback: `ethos gateway` and `ethos boot` print `whatsapp[<i>]: invalid default_mode '<value>'` and exit non-zero.
- Read once at gateway startup. Restart the gateway after editing.
- **The adapter's own fallback is `all`, not `mention_only`.** `DEFAULT_CHANNEL_MODE` in [`extensions/platform-whatsapp/src/config.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/platform-whatsapp/src/config.ts) is `all`, because an unset mode has always meant "answer every group message" for code that constructs `WhatsAppAdapter` directly and flipping it would silence a working embedder on upgrade. The gateway never leaves it unset — it passes `default_mode ?? 'mention_only'` — so an `ethos gateway` deployment gets `mention_only` like every other platform. The `all` fallback is reachable only by embedding the adapter yourself.
- **Per-chat overrides cannot be set on WhatsApp.** The adapter reads a per-chat override store (`ChannelOverrideStore`, JSONL under `~/.ethos/whatsapp/<botKey>/`) and a stored entry wins over this key, but no command or API writes one — Slack's `/ethos channel-mode` has no WhatsApp equivalent. This key is the only way to put a WhatsApp group into `observe` today, and it applies to every group that account is in.

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
