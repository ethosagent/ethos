---
title: "Telegram adapter"
description: "Operate Ethos on Telegram: token, routing to chats and groups, mention gate, allowlist and pairing, rate limits, multi-workspace, and the error catalog."
kind: how-to
audience: shared
slug: platform-telegram
time: "15 min"
updated: 2026-05-12
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
- The token saved to `telegramToken` in `~/.ethos/config.yaml` (run `ethos gateway setup` or hand-edit).
- The host can reach `api.telegram.org` over HTTPS.

## Source

- `extensions/platform-telegram/src/index.ts` — `TelegramAdapter` (long-polling via `grammy`, chunking, edit-in-place).
- `extensions/platform-telegram/src/validate.ts` — `getMe`-based token validation called by setup.
- `extensions/gateway/src/index.ts` — routing, slash commands, dedup, allowlist enforcement.
- `packages/safety/channel/src/channel-filter.ts` — sender allowlist, mention gate, DM policy.
- `apps/ethos/src/commands/gateway.ts` — adapter wiring (`new TelegramAdapter({ token, dropPendingUpdates: true })`).

## Steps

### 1. Wire the token

```yaml
# ~/.ethos/config.yaml
telegramToken: "123456789:ABCdefGhIJklmNopQRstuVwxYZ"
```

`ethos gateway setup` validates the token against `https://api.telegram.org/bot<TOKEN>/getMe` and writes the value for you. The portion before the colon is the numeric bot id; everything after is the secret — treat it like a password.

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

For production, wrap the same command in `launchd`, `systemd`, or `pm2` — see [Run Ethos as a daemon](../using/how-to/run-as-daemon.md).

### 3. Understand routing

`TelegramAdapter.start()` registers a `bot.on('message')` listener and forwards every text or caption as an `InboundMessage`. The gateway keys per `(platform, chatId)`:

| Chat type | `chatId` | `isDm` | `isGroupMention` | Effective session key |
|---|---|---|---|---|
| Private chat | user id | `true` | `false` | `telegram:<user-id>` |
| Group (bot is `@mentioned`) | negative group id | `false` | `true` | `telegram:<group-id>` |
| Group (reply to bot) | negative group id | `false` | `false` | `telegram:<group-id>` |
| Group (random chatter) | negative group id | `false` | `false` | dropped by the mention gate |

The session key forks when `/new` or `/personality <id>` runs in the chat — both append `:${Date.now()}` so the agent loses prior context cleanly. The previous session's outbound dedup keys are cleared at the same boundary.

Group chats share one session across every member. To give each user their own thread, deploy two bots and `/start` them privately.

### 4. Restrict who can talk to the bot

Default behaviour is **deny by default in groups, pairing flow in DMs.** Configure under `channelFilter.telegram` (`packages/safety/channel/src/channel-filter.ts`):

```yaml
channelFilter:
  telegram:
    ownerUserId: "1234567"          # numeric Telegram user id — always allowed
    recipientAllowlist:
      - "9876543"
      - "-1001234567890"            # whole group; negative ids
    dmPolicy: pairing               # pairing | allowlist | queue | reject | silent-drop
    contextVisibility: allowlist    # strip quoted text from non-allowlisted senders
```

Field meanings:

- `ownerUserId` — bypasses every gate, including the group mention gate. Required for `/allow`, `/deny`, `/communications` to take effect.
- `recipientAllowlist` — extra allowed user ids and group ids. Globs are accepted for the email adapter only.
- `dmPolicy` — what happens when a non-allowlisted user DMs the bot. `pairing` (default) replies with a one-time code; `allowlist` silently drops; `queue` parks the message for owner review; `reject` replies "not authorised"; `silent-drop` is the noisiest legacy mode.
- `contextVisibility` — `allowlist` strips quoted or threaded content from non-allowlisted senders before the agent sees it (defence against context smuggling).

From inside `ethos chat`:

```
/communications              # list pending pairing codes and approved senders
/allow 7H3K-9XQ2             # approve a sender by pairing code
/deny telegram 1234567       # revoke an approved sender
```

The gateway emits an audit event for every approve, deny, and context strip; `ethos audit` surfaces them.

### 5. Drive multi-workspace deployments

Telegram allows one long-polling consumer per token. To run several bots from one host:

- Run several gateways with separate `~/.ethos/` directories:

```bash
HOME=/srv/ethos-workspace-a ethos gateway start &
HOME=/srv/ethos-workspace-b ethos gateway start &
```

Each `HOME` gets its own `config.yaml`, SQLite store, logs, and pairing database. The bots stay isolated; sessions never cross.

- Or run one gateway with several platform adapters by attaching Discord and Slack tokens in the same `config.yaml`. The gateway processes every adapter against the same `MessageDedupCache` (30s TTL, keyed by `(sessionId, sha256(content))`) — duplicate outbound text on the same session is suppressed regardless of which adapter emitted it.

A single gateway cannot proxy two Telegram bots from the same token. Use distinct tokens or distinct `HOME` roots.

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

DM from a non-allowlisted account. With `dmPolicy: pairing`, the bot replies with a pairing code only — no agent turn fires. `ethos audit | tail` shows `channel.allowlist.blocked` (in groups) or `channel.pairing.sent`.

**Dedup is active.**

Send the same prompt twice within 30 seconds in the same chat. The second message gets an answer (inbound dedup keys on `messageId`, not content); the bot's reply is sent once if the generated text is identical.

## Troubleshoot

**`✓ Telegram online` never prints.**
The token is wrong or the host cannot reach `api.telegram.org`. Test `curl https://api.telegram.org/bot$TOKEN/getMe`. Regenerate with `/token` in BotFather if needed.

**Bot replies once, then nothing.**
Two consumers share the token. Telegram long-polling allows exactly one; the second hijacks updates intermittently. Kill the duplicate process or webhook. Look for stale `tmux` sessions, leftover `pm2` workers, or a parallel daemon.

**HTTP 429 from `sendMessage`.**
Telegram rate-limits at roughly 30 messages per second per bot and one message per second per chat. Streaming spikes are normal — the adapter edits in place rather than sending fresh chunks. Sustained 429s mean two bots share a token or a personality is replying to itself. Check `ethos errors` for `channel.pairing.sent` floods.

**HTTP 401 / 403 from `sendMessage`.**
The user blocked the bot, or the bot was kicked from the group. The gateway logs the error and the lane stays alive for other chats. Re-invite the bot or wait for the user.

**Markdown parse errors.**
Telegram's Markdown is strict (unmatched `_` or `*` rejects the whole message). The adapter retries as plain text on parse errors — see the `String(err).includes('parse')` fallback in `extensions/platform-telegram/src/index.ts`. If you still see truncated output, the personality is emitting Markdown the adapter cannot escape; switch the message to `parseMode: 'html'` from a [hook](../getting-started/glossary.md#hook).

**Replies arrive split into multiple messages.**
Expected. Telegram caps outbound text at 4,096 characters; `chunkText` splits at newlines (>60% of the limit) or spaces. Streamed edits re-flow with `reflowChunks` — first chunks are edited, extras are appended, trailing chunks are deleted.

**A message sent twice on purpose was answered only once.**
The outbound `MessageDedupCache` suppresses identical `(sessionId, content)` within 30 seconds. Change one character, wait 30 seconds, or set `ETHOS_DEDUP_LEGACY=1` to disable (one-release escape hatch — see `extensions/gateway/src/dedup.ts`).

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
- [Discord adapter](discord.md), [Slack adapter](slack.md) — the other channel adapters share the same gateway boundary.
- [Run Ethos as a daemon](../using/how-to/run-as-daemon.md) — `launchd`, `systemd`, `pm2`.
- [Glossary](../getting-started/glossary.md) — [`gateway`](../getting-started/glossary.md#gateway), [`session`](../getting-started/glossary.md#session), [`audience boundary`](../getting-started/glossary.md#audience-boundary).
