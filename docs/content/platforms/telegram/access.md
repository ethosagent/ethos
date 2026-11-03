---
title: "Telegram adapter: allowlist and multi-workspace"
description: "Restrict who can talk to the Telegram bot and run multiple workspaces."
kind: how-to
audience: shared
time: "5 min"
updated: 2026-11-03
---

## Task

Restrict which Telegram senders reach the agent, and run a second bot from a sibling `~/.ethos/`.

## Result

- Only allowlisted senders reach the agent; new DMs trigger the pairing-code flow.
- A second bot runs from a sibling `~/.ethos/` without interfering with the first.

## Prereqs

- The earlier steps on [Telegram adapter](../telegram.md) are done.

## Steps

### 4. Restrict who can talk to the bot

Default behaviour is **deny by default in groups, pairing flow in DMs.** Configure under `channel_filter.telegram` (`packages/safety/channel/src/channel-filter.ts`):

```yaml
# enable: false is an optional escape hatch — bypass the filter, keep the config
channel_filter.telegram.enable: false
# numeric Telegram user id — always allowed
channel_filter.telegram.ownerUserId: 1234567
# comma-separated user ids and group ids (group ids are negative)
channel_filter.telegram.recipientAllowlist: 9876543,-1001234567890
# pairing | decline | allowlist | queue | reject | silent-drop
channel_filter.telegram.dmPolicy: pairing
# optional; the refusal text `decline` sends
channel_filter.telegram.declineMessage: Thanks for writing. This assistant is private, so I can't reply.
# strip quoted text from non-allowlisted senders
channel_filter.telegram.contextVisibility: allowlist
```

Each field is one flat `channel_filter.telegram.<field>: <value>` line; the parser reads no nested block.

Field meanings:

- `enable` — explicit on/off switch for the whole filter on this platform. Omitted (the default) or `true` keeps the filter on. `false` bypasses every gate — allowlist, `dmPolicy`, mention gating, context visibility — so you can disable the filter without deleting the rest of the block.
- `ownerUserId` — bypasses every gate, including the group mention gate. Required for `/allow`, `/deny`, `/communications` to take effect.
- `recipientAllowlist` — extra allowed user ids and group ids. Globs are accepted for the email adapter only.
- `dmPolicy` — what happens when a non-allowlisted user DMs the bot. `pairing` (default) replies with a one-time code. `decline` replies once per sender per 24 h with a polite refusal and never in quiet hours. `allowlist`, `queue`, `reject` and `silent-drop` all drop the message without a reply (`checkMessage`, `packages/safety/channel/src/channel-filter.ts`). Nothing is parked for review.
- `declineMessage` — the refusal text `decline` sends, at most 500 characters. Omitted, it sends "Sorry, I can only reply to people who have been approved." The default names no owner, pairing code or policy.
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

- Or run one gateway with several platform adapters by attaching Discord and Slack tokens in the same `config.yaml`. The gateway processes every adapter against the same `MessageDedupCache` (30s TTL, keyed by `(sessionId, sha256(content))`, plus the inbound message on a reply — `replyDedupScope`) — a duplicate send on the same session is suppressed regardless of which adapter emitted it.

A single gateway cannot proxy two Telegram bots from the same token. Use distinct tokens or distinct `HOME` roots.

## Verify

Run the checks in [Verify](../telegram.md#verify).

## Troubleshoot

See [Troubleshoot](../telegram.md#troubleshoot).
