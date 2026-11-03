---
title: "Slack adapter: routing, allowlist and multi-workspace"
description: "Route Slack messages, restrict senders and run multiple workspaces."
kind: how-to
audience: shared
time: "5 min"
updated: 2026-11-03
---

## Task

Route Slack messages to per-channel sessions, restrict who can talk to the bot, and run a second workspace.

## Result

- Channels, threads, and DMs each get their own session keyed `slack:<channel-id>` / `slack:<thread-ts>` / `slack:<channel-id>` (DMs are channels of type `im`).
- A second workspace's app runs from a sibling `~/.ethos/` without interfering with the first.

## Prereqs

- The earlier steps on [Slack adapter](../slack.md) are done.

## Steps

### 4. Understand routing

`SlackAdapter.start()` subscribes to two events (`extensions/platform-slack/src/index.ts`):

- `message` — fires for every DM the bot can see. The adapter accepts messages with `channel_type === 'im'`; everything else is ignored at this layer.
- `app_mention` — fires for `@mentions` in channels. The adapter strips the `<@UXXXXXXXX>` token before forwarding.

| Source | `chatId` | `isDm` | `isGroupMention` | Effective session key |
|---|---|---|---|---|
| Channel `@mention` | channel id `C…` | `false` | `true` | `slack:<channel-id>` |
| Thread (channel mention with `thread_ts`) | channel id | `false` | `true` | `slack:<channel-id>` (replies go to the thread) |
| DM | channel id `D…` (type `im`) | `true` | `false` | `slack:<channel-id>` |

With [`slack.apps.<i>.mentionByName: true`](../../using/reference/config-yaml.md#mention-by-name), a channel message that names the bound personality as a whole word ("hey Owl, …") counts as a mention too (`isGroupMention: true`). Such a message is not an `app_mention`, so the adapter sees it only with the `message.channels` / `message.groups` subscriptions from [step 1a](unaddressed-messages.md#1a-platform-prerequisites-for-unaddressed-channel-messages). A message that reaches the agent only by naming it gets no receipt reaction.

When the inbound message has a `thread_ts` or the `replyToId` is set, the adapter passes `thread_ts` to `chat.postMessage` so the reply lands in the same thread. New top-level mentions start a new thread when the agent's reply spans multiple chunks.

The adapter skips messages with any `subtype` (bot messages, edits, joins) — Bolt surfaces those as `message` events too. Bot- and workflow-authored posts are the one exception: allowlist their `bot_id` under [`slack.apps.<i>.allowedBotIds`](../../using/reference/config-yaml.md#slack-apps) and they reach the agent.

### 4a. Plugin commands

Plugin commands registered via `registerSlashCommand()` are dispatched through the gateway's text-matching pipeline — the same path as built-in `/` commands.

Unlike Telegram and Discord, Slack requires manual slash command registration in the Slack app dashboard (`api.slack.com`). The gateway logs the list of commands that need registration at startup so operators can sync them. See [Register plugin slash commands](../../building/how-to/register-plugin-commands.md) for the full walkthrough.

### 5. Restrict who can talk to the bot

Configure under `channel_filter.slack` (`packages/safety/channel/src/channel-filter.ts`):

```yaml
# Slack user id — always allowed
channel_filter.slack.ownerUserId: U01ABCDEFGH
# comma-separated user ids or whole channel ids
channel_filter.slack.recipientAllowlist: U02ABCDEFGH,C03ABCDEFGH
# pairing | decline | allowlist | queue | reject | silent-drop
channel_filter.slack.dmPolicy: pairing
# strip quoted text from non-allowlisted senders
channel_filter.slack.contextVisibility: allowlist
```

Each field is one flat `channel_filter.slack.<field>: <value>` line.

Field meanings:

- `ownerUserId` — bypasses every gate, including the channel mention gate.
- `recipientAllowlist` — Slack user ids and channel ids that are also allowed.
- `dmPolicy` — what happens when a non-allowlisted user DMs the bot. `pairing` (default) replies with a one-time code; `decline` replies once per sender per 24 h with a polite refusal (`declineMessage` sets the wording); `allowlist`, `queue`, `reject` and `silent-drop` drop the message without a reply. See the [Telegram adapter](../telegram.md) for the full policy list.
- `contextVisibility: allowlist` — strips quoted Slack-thread content from non-allowlisted senders before the agent sees it.

From inside `ethos chat`:

```
/communications
/allow 7H3K-9XQ2
/deny slack U02ABCDEFGH
```

### 5a. Restrict who can run `/ethos` and open App Home

`/ethos` and the App Home tab never become inbound messages, so the filter above does not see them. They get their own gate, and it is default-deny: the allowlist is `ownerUserId` + `recipientAllowlist` from the block above, optionally narrowed by [`slack.apps.<i>.allowedSlashUsers`](../../using/reference/config-yaml.md#slack-apps).

```yaml
slack.apps.0.allowedSlashUsers: U01ABCDEFGH,U02ABCDEFGH
```

A user who is not on that allowlist gets an ephemeral "You are not authorized to use this command" and an App Home tab whose memory, session, kanban, and channel sections are replaced by a notice. Configure `ownerUserId` before rolling out: with no `channel_filter.slack` entry, nobody — including you — can run `/ethos memory add`, `/ethos channel-mode`, or read the bot's memory from App Home.

### 6. Drive multi-workspace deployments

A Slack app is installed per workspace. Each installation issues its own bot token. To run the same Ethos app across several workspaces:

- Run several gateways with separate `~/.ethos/` directories:

```bash
HOME=/srv/ethos-workspace-a ethos gateway start &
HOME=/srv/ethos-workspace-b ethos gateway start &
```

Each `HOME` carries its own `slackBotToken`, `slackAppToken`, `slackSigningSecret`, SQLite store, logs, and pairing database. The bots stay isolated; sessions never cross.

- Or run one gateway against one workspace and add Telegram or Discord tokens alongside. The same `MessageDedupCache` (30s TTL, keyed by `(sessionId, sha256(content))`, plus the inbound message on a reply — `replyDedupScope`) suppresses a duplicate send on the same session across every adapter.

A single Slack adapter instance binds to one bot token. Multi-tenant Slack distribution (one app, many workspaces, OAuth per workspace) is not yet wired through `apps/ethos/src/commands/gateway.ts`.

## Verify

Run the checks in [Verify](../slack.md#verify).

## Troubleshoot

See [Troubleshoot](../slack.md#troubleshoot).
