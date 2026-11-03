---
title: "Discord adapter: allowlist, permissions and multi-server"
description: "Restrict Discord senders, set bot permissions and run multiple servers."
kind: how-to
audience: shared
time: "5 min"
updated: 2026-11-03
---

## Task

Restrict who can talk to the Discord bot, grant its permissions, and run a second server.

## Result

- Allowlisted senders reach the agent; the gateway emits audit events when others are blocked or context-stripped.
- A second guild's bot runs from a sibling `~/.ethos/` without interfering with the first.

## Prereqs

- The earlier steps on [Discord adapter](../discord.md) are done.

## Steps

### 5. Restrict who can talk to the bot

Configure under `channel_filter.discord` (`packages/safety/channel/src/channel-filter.ts`):

```yaml
# Discord snowflake — always allowed
channel_filter.discord.ownerUserId: 234567890123456789
# comma-separated user snowflakes or whole channel snowflakes
channel_filter.discord.recipientAllowlist: 345678901234567890,456789012345678901
# pairing | decline | allowlist | queue | reject | silent-drop
channel_filter.discord.dmPolicy: pairing
# strip quoted text from non-allowlisted senders
channel_filter.discord.contextVisibility: allowlist
```

Each field is one flat `channel_filter.discord.<field>: <value>` line.

Field meanings:

- `ownerUserId` — bypasses every gate, including the mention gate inside guilds.
- `recipientAllowlist` — user and channel snowflakes that are also allowed.
- `dmPolicy` — what happens when a non-allowlisted user DMs the bot. `pairing` (default) replies with a one-time code; `decline` replies once per sender per 24 h with a polite refusal (`declineMessage` sets the wording); `allowlist`, `queue`, `reject` and `silent-drop` drop the message without a reply. See the [Telegram adapter](../telegram.md) for the full policy list.
- `contextVisibility: allowlist` — strips replied-to content from non-allowlisted senders before the agent sees it.

From inside `ethos chat`:

```
/communications
/allow 7H3K-9XQ2
/deny discord 234567890123456789
```

### 6. Required bot permissions

Invite the bot with these permissions (combined as the integer in the OAuth URL builder):

| Permission | Why |
|---|---|
| `View Channels` | Required to receive any event in a channel. |
| `Send Messages` | Required for replies. |
| `Send Messages in Threads` | Replies in threads when the source message was in a thread. |
| `Read Message History` | Lets the bot inspect the message it is replying to. |
| `Embed Links` | Discord auto-embeds links the agent emits. |
| `Add Reactions` | The receipt reaction on inbound messages. Without it the reaction fails silently and replies are unaffected. |
| `Use Application Commands` | Required for plugin slash commands registered as Discord application commands. |

Skip `Administrator`. The gateway has no need for moderation or member-management permissions; granting them widens the blast radius for nothing.

### 7. Drive multi-server deployments

Discord allows one gateway connection per bot token. To run several bots from one host:

- **One bot across many guilds (`Guilds` intent supports any number) with one gateway.** This is the path Discord supports natively. The same `MessageDedupCache` (30s TTL, keyed by `(sessionId, sha256(content))`, plus the inbound message on a reply — `replyDedupScope`) covers every guild and DM the bot serves.

- **Two or more Discord bots — run them under separate `~/.ethos/` roots, not in one process.**

```bash
HOME=/srv/ethos-guild-a ethos gateway start &
HOME=/srv/ethos-guild-b ethos gateway start &
```

Each `HOME` gets its own `config.yaml`, SQLite store, logs, and pairing database. The bots stay isolated; sessions never cross.

The multi-bot-in-one-process pattern that [Telegram and Slack support](../../using/how-to/run-multiple-bots.md) does not work for Discord yet — the adapter doesn't stamp `botKey` on inbound messages (see the [parity matrix](../discord.md#whats-shipped-vs-in-flight)). Two Discord bots in one Ethos process today collapse onto a single lane key and route to whichever loop was constructed first. Until that ships, separate `HOME` roots are the only safe way to run multiple Discord bots from one host.

## Verify

Run the checks in [Verify](../discord.md#verify).

## Troubleshoot

See [Troubleshoot](../discord.md#troubleshoot).
