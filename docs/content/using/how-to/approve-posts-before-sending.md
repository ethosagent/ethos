---
title: Approve posts before they go out
description: "Turn on outbound_policy so a personality queues its posts for approval, review the draft, and approve it on Telegram or in the web Outbox pane."
kind: how-to
audience: user
slug: approve-posts-before-sending
time: 20 min
updated: 2026-09-13
---

An agent that can post to your team's Slack channel will, eventually, post something you would not have. The approval outbox puts a human between the draft and the channel: the agent writes, you read the exact text, and nothing reaches anybody until you tap Approve.

## Task

Configure a [personality](../../getting-started/glossary.md#personality)'s `outbound_policy` so its `send_message` calls queue for approval, then approve one and watch it publish.

## Result

Every agent-initiated post from that personality on the named platforms lands in a durable queue at `~/.ethos/outbox.db`. You approve one exact revision from a Telegram card, the web Outbox pane, or `ethos outbox approve`, and the [gateway](../../getting-started/glossary.md#gateway) (the long-running process that holds the channel adapters) publishes it from the bot that was named on the card.

## Prereqs

- A personality you own at `~/.ethos/personalities/<id>/` (copy a built-in first with `ethos personality duplicate <built-in> <id>`).
- A Telegram bot or Slack app bound to that personality in `~/.ethos/config.yaml` — the outbox publishes from a bound bot, never from an arbitrary adapter.
- An entry for the personality in [`~/.ethos/messaging.json`](../reference/messaging-json.md). The operator allowlist is checked **before** the queue, so a target you have not allowed is refused rather than queued.
- `channel_filter.telegram.ownerUserId` set in `~/.ethos/config.yaml` if you want the Telegram approval card. Without it, approve in the web pane.

## 1. Turn the policy on

Add the block to `~/.ethos/personalities/<id>/config.yaml`:

```yaml
outbound_policy.approve_before_send: true
outbound_policy.channels: telegram
outbound_policy.approver_personality: brand-editor
```

`channels` is optional — leave it out to gate every platform. `approver_personality` is optional too; it names an advisory reviewer that reads the draft before you do. Only the literal `true` switches the gate on: `yes` and `True` parse as `false`.

Unknown platform names fail the personality load rather than silently un-gating a channel:

```
Invalid outbound_policy.channels: "telgram". Expected one of: slack, telegram, discord, whatsapp, email.
```

## 2. Confirm the personality is gated

```bash
ethos personality show <id>
```

The character sheet carries one publishing line, under the filesystem reach:

```
Publishing: approval required on telegram · reviewer: brand-editor · not covered: MCP tools, a2a_send
```

An ungated personality prints `Publishing: not gated — send_message goes out as soon as the agent calls it` instead. The `not covered` clause is not boilerplate: posts an agent makes through an MCP server's own tools, or through `a2a_send`, do not pass this gate at all.

## 3. Start a surface that wires the outbox

```bash
ethos gateway start
```

The gateway holds the bots, so it is the only process that publishes. Its dispatcher starts after the adapters are up and polls every 5 seconds.

Which command runs the turn decides what happens to a draft:

| Turn runs under | A gated `send_message` |
|---|---|
| `ethos gateway start` or `ethos boot` | Queues, and this process delivers it once you approve. |
| `ethos serve` | Queues. A gateway holding the sending bot has to be running to deliver it. |
| `ethos chat`, `ethos cron`, `ethos mcp` and the other one-shot commands | Nothing is queued and nothing is sent. These commands have no path to a channel, so `send_message` fails with `Gateway not active` for every personality. |

## 4. Let the agent draft

Ask the personality to post something. Its `send_message` returns without sending:

```
Queued for approval (obx_9f3c1a4b7d2e5081, revision 1). NOT sent. Nothing reached
telegram:-1001234567890 — a human has to approve it first, so do not tell anyone it was sent.
```

Two destinations skip the queue and send straight away, because neither is publishing: the chat the turn is already running in, and your own operator chat (`channel_filter.<platform>.ownerUserId`).

## 5. Read the reviewer's verdict

If you named an `approver_personality`, that personality runs one read-only turn over the draft before you see it. Its receipt rides on the card:

```
brand-editor: FAIL — "SOC2 certified" does not appear in truth-pack.md
```

The verdict is advisory and nothing more. A `FAIL` still reaches you, and a `PASS` approves nothing — the reviewer has no tool that can publish and no transition that can approve. If the reviewer is missing, broken or slow, the receipt reads `UNAVAILABLE` and the item still arrives.

## 6. Approve it

**On Telegram.** The bot that will publish DMs the card to your owner chat:

```
writer wants to post to telegram:-1001234567890 as @ExampleBot — revision 2

Ethos 0.9 ships tomorrow. Voice replies now redeliver after a restart.

brand-editor: PASS
[✅ Approve & send]  [❌ Reject]
```

Tap **Approve & send**. The card edits to `Approved by @you — sending…`, then `Sent 14:02`.

Only the configured owner's tap counts — anyone else who can see the card is told `Only the operator can approve publications.` and nothing changes. A tap on a card that an edit has superseded is refused with `Superseded — revision 3 is the current draft.` A draft too long for one Telegram message is not truncated; the card becomes a notice pointing you at the web pane, because approving text you cannot see is not approving.

**In the web UI.** Open **Outbox** in the personality's workspace (`/p/<id>/outbox`, and under a team at `/t/<team>/p/<id>/outbox`). Four sections: *Needs your approval*, *Approved · sending*, *Sent*, *Rejected & expired*. Each card shows the destination, the sending bot, the exact bytes, and the reviewer receipt, with **Approve**, **Edit** and **Reject**.

Editing writes revision n+1 and voids any approval on the previous one. Approving carries the revision and hash you read; if anything moved while you were looking, the call fails with `changed since you viewed it` and nothing is approved.

**From the terminal.** No card and no browser needed:

```bash
ethos outbox list
ethos outbox show obx_9f3c1a4b7d2e5081
```

`show` prints the destination, the sending bot, the reviewer receipt and the content hash, then the draft between `-----BEGIN DRAFT-----` and `-----END DRAFT-----`, byte for byte. Approve the revision you read:

```bash
ethos outbox approve obx_9f3c1a4b7d2e5081 --revision 2
ethos outbox reject obx_9f3c1a4b7d2e5081 --reason "wrong channel"
```

`--revision` is required, because an approval binds one exact text. If the draft was edited after you ran `show`, the approve fails with `changed since you viewed it` and nothing is approved. The command does not send anything itself. A gateway holding the sending bot publishes the approved revision on its next poll.

An item queued under `ethos serve` never gets a Telegram card, because a card is posted only by the process holding the sending bot. Approve it in the web pane or from the terminal.

## 7. Watch it publish

The dispatcher claims the approved row within about 5 seconds and publishes it from the bot named on the card, byte for byte. Until the claim lands you can still **Revoke**. After it lands you cannot: the pane says `Ethos cannot unsend this — delete it on Telegram.`

## Verify

Check the queue's own record of what happened:

```bash
ethos audit decisions --limit 5
```

An approval prints a row with the code `outbox.approve` carrying the item id, the bot, the destination and the content hash:

```
ethos audit  audit — decisions (1)

  TIMESTAMP            SEVERITY           CATEGORY / CODE
  ------------------------------------------------------------------------
  2026-09-12 14:02:11  info               audit.approval outbox.approve  → outbox obx_9f3c1a4b7d2e5081: approved revision 2
```

Every decision writes one row, whether you took it in the web pane, on the Telegram card, or with `ethos outbox`.

Then confirm the post arrived in the destination channel, from the bot the card named.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `send_message` fails with `Gateway not active — send_message requires gateway mode` | The turn ran under a command with no path to a channel (`ethos chat`, `ethos cron`, `ethos mcp`, …). Nothing was queued or sent | Run the turn under `ethos gateway start`, `ethos boot` or `ethos serve`. |
| An item queued from `ethos serve` has no Telegram card | Only the process holding the sending bot posts cards, and `ethos serve` holds none | Approve it in the web pane or with `ethos outbox approve <id> --revision <n>`. |
| `Ambiguous sender: 2 telegram bots are bound to personality "<id>"` | More than one bound bot and the turn names none | Run the request in the lane of the bot that should publish, or leave exactly one bound. |
| `no <platform> bot is bound to personality "<id>"` | No bot roster for that platform. `discord` and `email` have none at all | Bind a Telegram bot, Slack app or WhatsApp entry, or publish on a platform that has one. |
| `Target "<platform>:<target>" is not in the personality's allowed messaging targets` | The operator allowlist is checked before the queue | Add the target to `~/.ethos/messaging.json`. Approval never widens what the operator allowed. |
| No Telegram card, but the web pane shows the item | No `channel_filter.<platform>.ownerUserId`, or this process does not hold that bot | Set the owner id, or approve in the web pane. |
| An approved item sits in *Approved · sending* | Nothing that serves its bot is running | Start the gateway that holds that bot. The approval expires after 24 hours. |
| An item reads `failed` with `interrupted before the platform call; not sent — Retry` | The process claiming it died before the platform call | Press **Retry**. Ethos will not resend on its own — a resend on top of a possibly-live peer is how one approval becomes two posts. |

## Limits

- **The reviewer is advisory.** A human approves every publication; no verdict can approve or block one.
- **MCP tools and `a2a_send` are not gated.** A watcher's `deliver` is: it is refused at creation, and re-checked on every change, so a watcher stored before you turned the policy on stops posting to a third-party chat on its next change. `watcher_list` shows the withheld reason, which points you at `wake`. A watcher created before owners were recorded names no personality and still delivers — remove its entry from `~/.ethos/watchers/watchers.json` and recreate it.
- **Delivery is at-least-once.** An item handed to the delivery ledger without confirmation becomes `unconfirmed`, and the ledger — the record of every [delivery obligation](../../getting-started/glossary.md#delivery-obligation) Ethos owes — owns the retry from there. Telegram reports success on a multi-part message even when only part of it landed.
- **A sent publication cannot be unsent.** Delete it on the platform.
- **The windows are fixed in code**, not configurable: 7 days waiting for a human, 24 hours holding an approval, 10 minutes before a claimed-but-silent item is reconciled.

## See also

- [`outbound_policy` reference](../../building/reference/outbound-policy.md) — every field, state and refusal code.
- [`messaging.json` reference](../reference/messaging-json.md) — the allowlist checked before the queue.
- [Set up approval gates for dangerous tool calls](set-up-approval-gates.md) — the separate, in-memory mechanism for `terminal` and friends.
- [Send cross-channel messages](send-cross-channel-messages.md) — what `send_message` does when nothing gates it.
