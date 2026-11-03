---
title: "Discord adapter"
description: "Operate Ethos on Discord: bot token, intents, guild and DM routing, channel modes, allowlist, rate limits, multi-server, error catalog."
kind: how-to
audience: shared
slug: platform-discord
time: "15 min"
updated: 2026-11-03
---

## Task

Run the Ethos [gateway](../getting-started/glossary.md#gateway) against a Discord bot in a way that survives real traffic: connect with the right intents, route guild channels and DMs to per-channel [sessions](../getting-started/glossary.md#session), default to mention-only mode, restrict who can talk to the bot, stay under Discord's rate limit, and recognise the failure modes when they arrive.

## Result

- A Discord bot uses `Guilds`, `GuildMessages`, `MessageContent`, and `DirectMessages` intents and replies only to `@mentions` and DMs by default.
- Channels and DMs each get their own session keyed `discord:<channel-id>` / `discord:<user-id>`. Thread routing collapses to the parent channel today — see [What's shipped vs in flight](#whats-shipped-vs-in-flight).
- Allowlisted senders reach the agent; the gateway emits audit events when others are blocked or context-stripped.
- Outbound text is split into 2,000-character chunks, deduped over a 30-second window, and edited in place when the agent streams.
- A second guild's bot runs from a sibling `~/.ethos/` without interfering with the first.

## What's shipped vs in flight

The Discord adapter lags Slack and Telegram on several gateway-contract features. The matrix below is the operational truth; the full parity roadmap lives at [`plan/completed/discord-parity.md`](https://github.com/ethosagent/ethos/blob/main/plan/completed/discord-parity.md).

**Shipped today**

- Token validation via `users/@me` (`extensions/platform-discord/src/validate.ts`).
- `Guilds` / `GuildMessages` / `MessageContent` / `DirectMessages` intent setup.
- Channel modes in guild channels — `mention_only` (the default), `thread_follow`, `all`, `observe` — set server-wide with [`discord.defaultChannelMode`](../using/reference/config-yaml.md#discord-default-channel-mode). See [step 4a](discord/routing.md#4a-set-the-default-channel-mode).
- DM routing.
- Outbound chunking to Discord's 2,000-char cap with edit-in-place streaming.
- Clarify questions surface as buttons + modals, with the handler split across two modules — `extensions/platform-discord/src/clarify-blocks.ts` (component builders) and `extensions/platform-discord/src/clarify-interactions.ts` (button + modal callback handlers).
- Inbound attachments are downloaded from the Discord CDN into the attachment cache and surfaced on `InboundMessage.attachments`. Images become `type: 'image'`, audio uploads become `type: 'audio'` so the gateway transcribes them, executables are skipped, and anything over 25 MB is dropped.
- Outbound dedup via the shared `MessageDedupCache` (30s TTL).
- Receipt reaction: the bot reacts to an inbound message with the bound personality's [`display.emoji`](../using/reference/personality-yaml.md#display), else 👀, and clears it when the reply lands. See [Receipt reaction](../using/reference/config-yaml.md#receipt-reaction).
- Personality presence: [`discord.replyPrefix`](../using/reference/config-yaml.md#reply-prefix) puts the personality's name or emoji in front of every reply, and [`discord.mentionByName`](../using/reference/config-yaml.md#mention-by-name) counts a message that names the personality as a mention.
- Plugin commands registered via `registerSlashCommand()` are registered as Discord application commands at startup. They appear in the Discord command picker alongside built-in commands.

**Tracked on the parity plan, not yet shipped**

| Feature | What Slack and Telegram have | What Discord does today |
|---|---|---|
| `botKey` on `InboundMessage` | Stamped by the adapter; gateway routes by `${platform}:${botKey}:${chatId}`. | Not populated. Multi-bot Discord deployments collapse to one lane. See [Run multiple bots](../using/how-to/run-multiple-bots.md). |
| Thread routing | Slack uses `thread_ts`; Telegram uses forum topics. Each gets a distinct `threadId`. | Discord threads are flattened into the parent channel; replies land in the parent, not the thread. |
| Per-channel mode command | Slack's `/ethos channel-mode <mode>` writes a per-channel override. | No writer. The mode is server-wide via `discord.defaultChannelMode`; `/ethos help` reads the effective mode but nothing sets it. See [step 4a](discord/routing.md#4a-set-the-default-channel-mode). |
| Approval surface | Slack renders the `before_ticket_complete` hook as an approval card. | Not implemented — Discord users can't participate in `kanban_complete` approvals. |

The parity plan is shipping in nine independent moves; expect this matrix to shrink rather than grow. If you are operating a Discord-only deployment and one of the gaps blocks you, that's the gap to file against next.

## Prereqs

- `ethos chat` works locally with a configured LLM provider.
- A Discord application and bot token from `https://discord.com/developers/applications`.
- The **Message Content Intent** enabled in the Developer Portal under **Bot → Privileged Gateway Intents** (required for the adapter to see message text).
- The bot invited to the target guild with `bot` and `applications.commands` scopes and at minimum `Send Messages`, `Read Message History`, `View Channels` permissions.

## Source

- `extensions/platform-discord/src/index.ts` — `DiscordAdapter` (`discord.js` v14 gateway client, intents, mention gate, chunking, edit-in-place).
- `extensions/platform-discord/src/validate.ts` — `users/@me`-based token validation called by setup.
- `extensions/gateway/src/index.ts` — routing, slash commands, dedup, allowlist enforcement.
- `packages/safety/channel/src/channel-filter.ts` — sender allowlist, mention gate, DM policy.
- `apps/ethos/src/commands/gateway.ts` — adapter wiring (`new DiscordAdapter({ token: config.discordToken })`).

## Parts

| Part | Covers |
|---|---|
| This page | What is shipped; steps 1-3: token, start the gateway, intents; then Verify, Troubleshoot and errors. |
| [Discord adapter: routing and channel mode](./discord/routing.md) | Steps 4-4a: routing and the default channel mode. |
| [Discord adapter: allowlist, permissions and multi-server](./discord/access.md) | Steps 5-7: allowlist, required bot permissions, multi-server deployments. |

## Where things moved

| Section | Page |
|---|---|
| <a id="4-understand-routing"></a>[4. Understand routing](discord/routing.md#4-understand-routing) | [Discord adapter: routing and channel mode](discord/routing.md) |
| <a id="4a-set-the-default-channel-mode"></a>[4a. Set the default channel mode](discord/routing.md#4a-set-the-default-channel-mode) | [Discord adapter: routing and channel mode](discord/routing.md) |
| <a id="5-restrict-who-can-talk-to-the-bot"></a>[5. Restrict who can talk to the bot](discord/access.md#5-restrict-who-can-talk-to-the-bot) | [Discord adapter: allowlist, permissions and multi-server](discord/access.md) |
| <a id="6-required-bot-permissions"></a>[6. Required bot permissions](discord/access.md#6-required-bot-permissions) | [Discord adapter: allowlist, permissions and multi-server](discord/access.md) |
| <a id="7-drive-multi-server-deployments"></a>[7. Drive multi-server deployments](discord/access.md#7-drive-multi-server-deployments) | [Discord adapter: allowlist, permissions and multi-server](discord/access.md) |

## Steps

### 1. Wire the token

```yaml
# ~/.ethos/config.yaml
discordToken: "MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.Yy....your-bot-token-here"
```

`ethos gateway setup` validates the token by calling `https://discord.com/api/users/@me` with `Authorization: Bot <token>` and writes the value for you.

### 2. Start the gateway

```bash
ethos gateway start
```

Expected boot lines include `✓ Discord online`. For production with the web dashboard alongside, use `ethos run-all` under PM2 — see [Deploy in production](../using/how-to/deploy-in-production.md). For just the Discord gateway by itself under `launchd` / `systemd` / `pm2`, see [Run Ethos as a daemon](../using/how-to/run-as-daemon.md).

### 3. Confirm intents

`DiscordAdapter` constructs the client with these intents (see `extensions/platform-discord/src/index.ts`):

| Intent | Why |
|---|---|
| `Guilds` | Receive guild metadata so channel ids resolve. |
| `GuildMessages` | Receive `MessageCreate` events in server channels. |
| `MessageContent` | Read the actual text of messages. **Privileged** — must be enabled in the Developer Portal. |
| `DirectMessages` | Receive DMs sent to the bot. |

`Partials.Channel` and `Partials.Message` are also requested so DMs work without a cache prefetch.

If `✓ Discord online` prints but the bot ignores every mention, **Message Content Intent is off in the Developer Portal**. Toggle it on, restart the gateway.

## Verify

**Token works.**

```bash
curl -s -H "Authorization: Bot $DISCORD_TOKEN" https://discord.com/api/users/@me | jq .username
```

Returns the bot's username. `401` means the token is revoked or wrong; regenerate it in the Developer Portal.

**Gateway sees Discord.**

Foreground-start the gateway and confirm `✓ Discord online`. The adapter's `health()` reports `ok: true` only after `client.ws.status === 0` (i.e. `Ready`).

**Mention round-trips in a guild.**

Post `@Ethos ping` in a channel the bot can see. Reply arrives in the same channel. A non-mentioned `ping` produces no reply when `mentionOnly: true`.

**DM round-trips.**

DM the bot `ping`. Reply arrives within a few seconds — provided the DM passes the allowlist or pairing flow.

**Allowlist enforcement.**

Have a non-allowlisted account `@mention` the bot in a guild. With the default config, the message is silently dropped and `ethos audit | tail` shows `channel.allowlist.blocked` or `channel.mention_gate`.

**Dedup is active.**

Send the same prompt twice within 30 seconds. The bot answers both, even with identical text — reply dedup is scoped to the inbound message it answers (`replyDedupScope`, pinned by `extensions/gateway/src/__tests__/dedup-reply-scope.test.ts`). What dedup drops is one reply sent twice.

## Troubleshoot

**`✓ Discord online` prints but the bot ignores every message.**
**Message Content Intent** is off in the Developer Portal. Open the application, **Bot** → **Privileged Gateway Intents**, enable it, restart the gateway.

**Bot is online but never sees messages in one channel.**
Channel permissions override role permissions. Check **Edit Channel** → **Permissions** → the bot's role has `View Channel` and `Read Message History`. The `Guilds` intent is global; per-channel ACLs are not.

**Bot replies appear out of order or are dropped.**
A long agent turn is being interrupted by a fresh message in the same channel. `SessionLane` serialises turns per `(platform, chatId)`; the second message queues behind the first. The user sees the second reply land only after the first finishes. Tell users to wait or run `/stop` to abort the current turn.

**HTTP 429 / Discord rate-limit warnings.**
`discord.js` handles per-route rate limits internally. Sustained 429s mean a personality is auto-replying or the same bot is responding from two processes. Check `ethos errors` and the running gateway count.

**Replies arrive split into multiple messages.**
Expected. Discord caps outbound text at 2,000 characters; `chunkText` splits at newlines (>60% of the limit). Streamed edits re-flow with `reflowChunks` — first chunks are edited, extras are appended, trailing chunks are deleted.

**Bot was kicked from the server, gateway keeps logging fetch failures.**
`channels.fetch(chatId)` will start returning 404. The adapter logs the delivery failure and the lane stays alive for other chats. Re-invite or wait. If the chat id is the wrong type altogether (e.g. a category), `'send' in channel` is false and the adapter returns `Channel not found or not sendable`.

**A message sent twice on purpose was answered only once.**
The outbound `MessageDedupCache` suppresses identical `(sessionId, content)` within 30 seconds for notices and `send_message` sends; a reply is only suppressed when the same reply to the same inbound message is sent twice. Change one character, wait 30 seconds, or set `ETHOS_DEDUP_LEGACY=1` to disable.

**Pairing code expired.**
Codes have a TTL in `packages/safety/channel/src/pairing-store.ts`. If the DM author waited too long, they need to DM again — a new code is issued. Owners can `/communications approve-all` to approve every pending sender.

**Bot does not appear in `member.roles` or replies to a role mention.**
Role mentions are not the same as user mentions; the adapter only checks `message.mentions.has(client.user)`. Mention the bot directly (`@Ethos`) rather than a role the bot has.

## Errors you may see

| Code | Surface | Cause | Fix |
|---|---|---|---|
| `channel.allowlist.blocked` | gateway audit | Non-allowlisted sender in a guild, or DM under `dmPolicy: silent-drop`. | Add the snowflake to `recipientAllowlist` or trigger `/allow <code>`. |
| `channel.mention_gate` | gateway audit | Allowlisted sender posted in a guild without `@mentioning` the bot. | Mention the bot or reply to one of its messages. |
| `channel.pairing.sent` | gateway audit | First DM from a non-allowlisted user; pairing code emitted. | Owner runs `/allow <code>` to approve. |
| `channel.context_stripped` | gateway audit | Quoted content from a non-allowlisted user was removed before the turn. | Expected when `contextVisibility: allowlist`. |
| `channel.prior_context_stripped` | gateway audit | Channel-backfill lines from non-allowlisted authors were removed; `details.dropped` is `true` when nothing survived. | Expected when `contextVisibility: allowlist`. Add the author's snowflake to `recipientAllowlist` to keep their lines. |
| `Channel not found or not sendable` | delivery result | Bot was kicked, channel deleted, or `chatId` is not a text channel. | Re-invite or update routing. |

## See also

- [Telegram adapter](telegram.md) — same gateway surface, different ingress.
- [Slack adapter](slack.md) — socket mode, bot scopes, signing secret.
- [Run multiple bots from one Ethos process](../using/how-to/run-multiple-bots.md) — multi-bot wiring on Telegram and Slack; Discord caveats called out.
- [Run Ethos as a daemon](../using/how-to/run-as-daemon.md) — `launchd`, `systemd`, `pm2`.
- [Glossary](../getting-started/glossary.md) — [`gateway`](../getting-started/glossary.md#gateway), [`session`](../getting-started/glossary.md#session), [`audience boundary`](../getting-started/glossary.md#audience-boundary).
