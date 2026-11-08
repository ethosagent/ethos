---
title: "Telegram adapter"
description: "Operate Ethos on Telegram: token, routing to chats and groups, mention gate, allowlist and pairing, rate limits, multi-workspace, and the error catalog."
kind: how-to
audience: shared
slug: platform-telegram
time: "15 min"
updated: 2026-11-03
---

## Task

Run the Ethos [gateway](../getting-started/glossary.md#gateway) against a Telegram bot in a way that survives real traffic: route private chats and group mentions to the right [session](../getting-started/glossary.md#session), restrict who can DM, stay under Telegram's send rate, run a second bot from the same host, and recognise the failure modes when they arrive.

For zero-to-first-message, follow [Deploy your first Telegram agent](../using/tutorials/first-deploy-telegram.md) — this how-to picks up where the tutorial ends.

## Result

- A Telegram bot routes inbound updates through `TelegramAdapter` → `Gateway` → `AgentLoop`.
- Private chats, replies, and `@mentions` in groups land in the correct session; everything else is dropped.
- Only allowlisted senders reach the agent; new DMs trigger the pairing-code flow.
- Outbound text is split into 4,096-character chunks, deduped over a 30-second window, and edited in place when the agent streams.
- A second bot runs from a sibling `~/.ethos/` without interfering with the first.

## Prereqs

- `ethos chat` works locally with a configured LLM provider.
- A bot token from `@BotFather` (the `/newbot` flow).
- BotFather's **Group Privacy** setting decided for the bot. It governs what Telegram delivers to a bot in a group and cannot be overridden from `~/.ethos/config.yaml` — see [Platform prerequisites for group messages](telegram/routing.md#3b-platform-prerequisites-for-group-messages).
- The token saved to `telegramToken` in `~/.ethos/config.yaml` (run `ethos gateway setup` or hand-edit).
- The host can reach `api.telegram.org` over HTTPS.

## Source

- `extensions/platform-telegram/src/index.ts` — `TelegramAdapter` (long-polling via `grammy`, chunking, edit-in-place).
- `extensions/platform-telegram/src/validate.ts` — `getMe`-based token validation called by setup.
- `extensions/gateway/src/index.ts` — routing, slash commands, dedup, allowlist enforcement.
- `packages/safety/channel/src/channel-filter.ts` — sender allowlist, mention gate, DM policy.
- `apps/ethos/src/commands/gateway.ts` — adapter wiring (`new TelegramAdapter({ token, dropPendingUpdates })`, passed through from config; the adapter defaults it to `false`).

## Parts

| Part | Covers |
|---|---|
| This page | Steps 1-2: token, multiple bots, start the gateway; then Verify, Troubleshoot and errors. |
| [Telegram adapter: routing and group messages](./telegram/routing.md) | Steps 3-3b: routing, plugin commands, platform prerequisites for group messages. |
| [Telegram adapter: allowlist and multi-workspace](./telegram/access.md) | Steps 4-5: allowlist and pairing, multi-workspace deployments. |

## Where things moved

| Section | Page |
|---|---|
| <a id="3-understand-routing"></a>[3. Understand routing](telegram/routing.md#3-understand-routing) | [Telegram adapter: routing and group messages](telegram/routing.md) |
| <a id="3a-plugin-commands"></a>[3a. Plugin commands](telegram/routing.md#3a-plugin-commands) | [Telegram adapter: routing and group messages](telegram/routing.md) |
| <a id="3b-platform-prerequisites-for-group-messages"></a>[3b. Platform prerequisites for group messages](telegram/routing.md#3b-platform-prerequisites-for-group-messages) | [Telegram adapter: routing and group messages](telegram/routing.md) |
| <a id="4-restrict-who-can-talk-to-the-bot"></a>[4. Restrict who can talk to the bot](telegram/access.md#4-restrict-who-can-talk-to-the-bot) | [Telegram adapter: allowlist and multi-workspace](telegram/access.md) |
| <a id="5-drive-multi-workspace-deployments"></a>[5. Drive multi-workspace deployments](telegram/access.md#5-drive-multi-workspace-deployments) | [Telegram adapter: allowlist and multi-workspace](telegram/access.md) |

## Steps

### 1. Wire the token

```yaml
# ~/.ethos/config.yaml
telegramToken: "123456789:ABCdefGhIJklmNopQRstuVwxYZ"
```

`ethos gateway setup` validates the token against `https://api.telegram.org/bot<TOKEN>/getMe` and writes the value for you. The portion before the colon is the numeric bot id; everything after is the secret — treat it like a password.

### 1a. Run multiple bots from one process

The `telegramToken` scalar wires one bot. To run two or more bots from the same gateway process, replace it with the `telegram.bots` list:

```yaml
# ~/.ethos/config.yaml

telegram.bots.0.token: "123456:ABCdefGhIJklmNopQRstuVwxYZ"
telegram.bots.0.id: researcher-bot
telegram.bots.0.bind.type: personality
telegram.bots.0.bind.name: researcher

telegram.bots.1.token: "654321:XYZabcDeFgHijKlMnOpqRsTuV"
telegram.bots.1.id: coder-bot
telegram.bots.1.bind.type: personality
telegram.bots.1.bind.name: engineer
```

Each entry in `telegram.bots` creates one `TelegramAdapter` and one `AgentLoop`. The `id` field is a stable key for session lane names and log output — set it once and do not change it.

The old scalar shape still works and is not going away in the current major version. When both `telegramToken` and `telegram.bots` are present, `telegram.bots` takes precedence and the scalar is ignored with a deprecation warning.

For a full walkthrough, see [Run multiple Telegram bots from one process](../using/how-to/run-multi-bot-telegram.md).

### 2. Start the gateway

```bash
ethos gateway start
```

Expected boot lines:

```
ethos gateway  starting...
✓ Telegram online (412ms)
Listening for messages. Press Ctrl+C to stop.
```

For production with the web dashboard alongside, use `ethos run-all` under PM2 — see [Deploy in production](../using/how-to/deploy-in-production.md). For just the Telegram gateway by itself under `launchd` / `systemd` / `pm2`, see [Run Ethos as a daemon](../using/how-to/run-as-daemon.md).

## Verify

Run each check in order; stop at the first failure and fix.

**Bot is up.**

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_TOKEN/getMe" | jq .ok
```

Returns `true`. A `false` or HTTP error means the token is invalid or revoked.

**Gateway sees the bot.**

Foreground-start the gateway and confirm `✓ Telegram online (Nms)`. Latency above 1500 ms means a network or DNS issue, not a Telegram outage.

**Private DM round-trips.**

DM the bot `ping`. Reply arrives within a few seconds. Check `~/.ethos/logs/gateway.out.log` if not.

**Group mention round-trips.**

Add the bot to a group, post `@yourbotname ping`. Reply appears in the same chat. A non-mentioned `ping` produces no reply — that is the mention gate doing its job.

**Allowlist enforcement.**

DM from a non-allowlisted account. With `dmPolicy: pairing`, the bot replies with a pairing code only — no agent turn fires. `ethos audit | tail` shows `channel.allowlist.blocked` (in groups) or `channel.pairing.issued`.

**Dedup is active.**

Send the same prompt twice within 30 seconds in the same chat. The second message gets an answer (inbound dedup keys on `messageId`, not content), and its reply is sent even when the generated text is identical — reply dedup is scoped to the inbound message it answers (`replyDedupScope`, pinned by `extensions/gateway/src/__tests__/dedup-reply-scope.test.ts`).

## Troubleshoot

**`✓ Telegram online` never prints.**
The token is wrong or the host cannot reach `api.telegram.org`. Test `curl https://api.telegram.org/bot$TOKEN/getMe`. Regenerate with `/token` in BotFather if needed.

**Bot replies once, then nothing.**
Two consumers share the token. Telegram long-polling allows exactly one; the second hijacks updates intermittently. Kill the duplicate process or webhook. Look for stale `tmux` sessions, leftover `pm2` workers, or a parallel daemon.

**The bot is in the group but sees nothing except mentions.**
BotFather's Group Privacy is on for that group. Run `curl -s "https://api.telegram.org/bot$TOKEN/getMe"` and read `can_read_all_group_messages`: `false` means privacy mode is on. If it already reports `true`, the setting was changed after the bot joined — remove the bot from the group and add it back. See [Platform prerequisites for group messages](telegram/routing.md#3b-platform-prerequisites-for-group-messages).

**HTTP 429 from `sendMessage`.**
Telegram rate-limits at roughly 30 messages per second per bot and one message per second per chat. Streaming spikes are normal — the adapter edits in place rather than sending fresh chunks. Sustained 429s mean two bots share a token or a personality is replying to itself. Check `ethos errors` for `channel.pairing.sent` floods.

**HTTP 401 / 403 from `sendMessage`.**
The user blocked the bot, or the bot was kicked from the group. The gateway logs the error and the lane stays alive for other chats. Re-invite the bot or wait for the user.

**Markdown parse errors.**
Telegram's Markdown is strict (unmatched `_` or `*` rejects the whole message). The adapter retries as plain text on parse errors — see the `String(err).includes('parse')` fallback in `extensions/platform-telegram/src/index.ts`. If you still see truncated output, the personality is emitting Markdown the adapter cannot escape; switch the message to `parseMode: 'html'` from a [hook](../getting-started/glossary.md#hook).

**Replies arrive split into multiple messages.**
Expected. Telegram caps outbound text at 4,096 characters; `chunkText` splits at newlines (>60% of the limit) or spaces. Streamed edits re-flow with `reflowChunks` — first chunks are edited, extras are appended, trailing chunks are deleted.

**A message sent twice on purpose was answered only once.**
The outbound `MessageDedupCache` suppresses identical `(sessionId, content)` within 30 seconds for notices and `send_message` sends; a reply is only suppressed when the same reply to the same inbound message is sent twice. Change one character or wait 30 seconds.

**Pairing code expired.**
Codes live for the configured TTL in `pairing-store.ts`. If the user waited too long, ask them to DM again — a new code is issued. Owners can also `/communications approve-all` to approve every pending sender at once.

**Bot crashes the gateway on startup.**
A bad token rejects from `bot.start()` and used to kill the whole gateway. `extensions/platform-telegram/src/index.ts` catches the rejection now and logs `[telegram] bot polling stopped: <detail>`; other adapters keep running. If you see no log line and the process dies, file an issue — that is a regression.

**Two bots both reply to one user.**
Both bots share a `recipientAllowlist` entry and both are members of the same group. Either restrict the allowlists per bot or run them under separate `HOME` roots so they cannot see each other's pairing database.

## Errors you may see

| Code | Surface | Cause | Fix |
|---|---|---|---|
| `channel.allowlist.blocked` | gateway audit | Non-allowlisted sender in a group, or DM under `dmPolicy: silent-drop`. | Add the user id to `recipientAllowlist` or trigger `/allow <code>`. |
| `channel.mention_gate` | gateway audit | Allowlisted sender posted in a group without `@mentioning` the bot. | Mention the bot or reply to one of its messages. |
| `channel.pairing.sent` | gateway audit | First DM from a non-allowlisted user; pairing code emitted. | Owner runs `/allow <code>` to approve. |
| `channel.context_stripped` | gateway audit | Quoted content from a non-allowlisted user was removed before the turn. | Expected when `contextVisibility: allowlist`. |
| `telegram: bot polling stopped` | stderr | Token invalid, network drop, or another consumer claimed the long-poll. | Fix the token or kill the duplicate consumer. |

## See also

- [Deploy your first Telegram agent](../using/tutorials/first-deploy-telegram.md) — narrative tutorial covering BotFather, daemons, and the pairing flow end-to-end.
- [Run multiple Telegram bots from one process](../using/how-to/run-multi-bot-telegram.md) — full walkthrough of the `telegram.bots` list shape and per-bot personality binding.
- [Connect a Telegram bot to a team](../using/how-to/connect-telegram-to-team.md) — bind a bot to a team coordinator and auto-start the team supervisor.
- [Discord adapter](discord.md), [Slack adapter](slack.md) — the other channel adapters share the same gateway boundary.
- [Channel capability matrix](capability-matrix.md) — what every adapter supports for typing, streaming edits, media, and threads.
- [Run Ethos as a daemon](../using/how-to/run-as-daemon.md) — `launchd`, `systemd`, `pm2`.
- [Glossary](../getting-started/glossary.md) — [`gateway`](../getting-started/glossary.md#gateway), [`session`](../getting-started/glossary.md#session), [`audience boundary`](../getting-started/glossary.md#audience-boundary).
