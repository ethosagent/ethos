---
title: "outbound_policy — the approval outbox"
description: "The outbound_policy personality field: its three sub-keys, the send_message gate, the publication lifecycle, the content binding, and what is not covered."
kind: reference
audience: developer
slug: outbound-policy
updated: 2026-11-03
---

`outbound_policy` is the [personality](../../getting-started/glossary.md#personality) field (a directory of files that decides an agent's tools, memory, and model) that turns an agent-initiated `send_message` into a queued proposal instead of a send. A human approves one exact revision of one text to one destination from one bot, and only then does it go out.

The queue is durable SQLite at `~/.ethos/outbox.db`. The agent's [tool](../../getting-started/glossary.md#tool) call returns `Queued for approval (obx_…, revision 1). NOT sent.` and the turn continues.

## Source {#source}

| Concern | Where it lives |
|---|---|
| Field type | [`packages/types/src/personality.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/personality.ts) — `OutboundPolicyConfig`, `PersonalityConfig.outbound_policy` |
| Parse + validation | [`extensions/personalities/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/personalities/src/index.ts) — `buildOutboundPolicy`, `parseOutboundChannels`, `OUTBOUND_POLICY_PLATFORMS` |
| The gate | [`extensions/tools-messaging/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-messaging/src/index.ts) — `gateSend` inside `executeSendMessage` |
| Gate construction | [`packages/wiring/src/compose-tools.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/compose-tools.ts) — `createOutboxGate` |
| Store, lifecycle, hash | [`extensions/outbox/src/`](https://github.com/ethosagent/ethos/tree/main/extensions/outbox/src) — `SQLiteOutboxStore`, `OutboxService`, `computeContentHash` |
| Sender, reviewer, dispatcher, cards | [`apps/ethos/src/lib/outbox-wiring.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/lib/outbox-wiring.ts) |
| Delivery | [`extensions/gateway/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/gateway/src/index.ts) — `Gateway.deliverPublication` |
| Terminal approval surface | [`apps/ethos/src/commands/outbox.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/outbox.ts) — `ethos outbox list \| show \| approve \| reject` |
| Web approval surface | [`packages/web-contracts/src/routes/delivery.ts`](https://github.com/ethosagent/ethos/blob/main/packages/web-contracts/src/routes/delivery.ts) (`outbox.*`), [`apps/web-api/src/services/outbox.service.ts`](https://github.com/ethosagent/ethos/blob/main/apps/web-api/src/services/outbox.service.ts), [`apps/web/src/pages/Outbox.tsx`](https://github.com/ethosagent/ethos/blob/main/apps/web/src/pages/Outbox.tsx) |

## Fields {#fields}

Written in `~/.ethos/personalities/<id>/config.yaml` as flat dotted keys. The schema is frozen and `outbound_policy` counts as one field ([personality governance](../explanation/personality-governance.md)).

```yaml
outbound_policy.approve_before_send: true
outbound_policy.channels: telegram slack
outbound_policy.approver_personality: brand-editor
```

| Key | Type | Default | Description |
|---|---|---|---|
| `approve_before_send` | boolean | absent | Turns the gate on. Only the literal string `true` enables it — `buildOutboundPolicy` compares `approve === 'true'`, so `yes`, `True` and `1` all parse as `false`. When the key is absent the whole block is skipped and nothing is parsed. |
| `channels` | whitespace-separated platform names | absent | Which platforms the gate covers. Absent means every platform. An empty list is read as every platform too — `createOutboxGate` treats `channels.length === 0` the same as `undefined`, because the reading that gates more is the one a mis-parsed list survives. An unknown name fails the personality load. |
| `approver_personality` | personality id | absent | An advisory reviewer that reads the draft before the human does. It can neither approve nor block — see [Reviewer](outbound-policy/review-and-delivery.md#reviewer). |

Each sub-key is independent of the others in parsing but not in effect: `approve_before_send: false` ignores `channels` at runtime, while a bad name inside `channels` still fails the load.

## Platform vocabulary {#platforms}

`channels` may name these five, and nothing else — `OUTBOUND_POLICY_PLATFORMS`:

| Name | Gate fires on a `send_message` to that platform | A bot roster exists to publish from |
|---|---|---|
| `telegram` | Yes | Yes — `telegram.bots` |
| `slack` | Yes | Yes — `slack.apps` |
| `whatsapp` | Yes | Yes — `whatsapp` entries carrying a `bind` |
| `discord` | Yes | **No** — see the note below |
| `email` | Yes | **No** — see the note below |

An unknown platform name **fails the personality load** with `Invalid outbound_policy.channels: "<name>". Expected one of: slack, telegram, discord, whatsapp, email.` — thrown by `parseOutboundChannels`. A typo that matched nothing would leave the platform ungated while the config read as if it were gated, so the failure is deliberate and it does not depend on `approve_before_send` being `true`.

The list is a deliberate copy of `SEND_MESSAGE_PLATFORMS` in `extensions/tools-messaging/src/index.ts` (`@ethosagent/personalities` must not import a sibling extension). The two are pinned equal by `packages/wiring/src/__tests__/outbound-policy-platforms.test.ts`.

**`discord` and `email` gate but cannot publish.** `buildBotSpeakers` ([`apps/ethos/src/commands/gateway.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/gateway.ts)) builds its bot roster from Telegram bots, Slack apps and bound WhatsApp entries only. For a gated personality, a `send_message` to `discord` or `email` therefore resolves zero sender candidates and `resolveSender` refuses the proposal outright: nothing is queued and nothing is sent. The tool returns the refusal for the agent to read.

## What the gate covers {#coverage}

| Path | Gated? | Enforced by |
|---|---|---|
| Agent-initiated `send_message` to a third party | Yes | `gateSend` returns the queued result before `opts.send` is reached (`extensions/tools-messaging/src/index.ts`) |
| `send_message` to the turn's own chat (`${platform}:${target}` equals `ctx.origin`) | No — exempt | `gateSend`; that destination is the conversation, where an ordinary reply lands anyway |
| `send_message` to the operator's chat (`channel_filter.<platform>.ownerUserId`) | No — exempt | `gateSend` via `OutboxGate.ownerTarget` |
| A target outside the operator allowlist | Refused, never queued | The `getAllowedTargets` check runs **before** `gateSend` in `executeSendMessage`, so approval can never widen what the operator allowed |
| `watcher_create` with a `deliver` target that is neither exempt destination | Refused, pointed at `wake` | `refuseForeignDeliver` in [`extensions/tools-watchers/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-watchers/src/index.ts) |
| A stored watcher's `deliver`, on every change, to a target that is neither exempt destination | Withheld, not sent. The reason, pointing at `wake`, is stored on the watcher (`deliveryWithheld`), logged, and shown by `watcher_list`; a `wake` on the same watcher still fires | `WatcherManager.dispatchChange` in [`extensions/watchers/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/watchers/src/index.ts), through the same `isForeignDeliverForGatedOwner` predicate the creation refusal uses |
| Conversational replies, cron delivery to `job.origin`, goal notes, owner notices, channel digests, team/mesh dispatch | No | None of them publishes agent-drafted text to a third party; they never call the gate |
| MCP tools that post, and `a2a_send` | **No — not covered at all** | Nothing. Stated on every character sheet by `publishingLine` (`extensions/personalities/src/character-sheet.ts`): `not covered: MCP tools, a2a_send` |
| Dry runs and replays | Never reach the gate | `executeParallel` returns `synthesizeDryRunResult` without calling `execute` (`packages/core/src/tool-registry.ts`) |

## Where the gate is wired {#surfaces}

A turn reaches a channel through two seams. `send_message` sends only after the host calls `setMessagingSend`; until then it returns wiring's default `gatewaySendRef` error, `Gateway not active — send_message requires gateway mode` (`packages/wiring/src/compose-tools.ts`). A watcher's `deliver` needs the watcher tools, which are registered only when the host constructs a `WatcherManager`. Every command that holds either seam builds the outbox from [`apps/ethos/src/lib/outbox-wiring.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/lib/outbox-wiring.ts):

| Command | Path to a channel | Outbox |
|---|---|---|
| `ethos gateway start`, `ethos boot` | Adapters in the process | The whole outbox, `createOutboxRuntime`: gate, reviewer, Telegram cards, and the dispatcher that delivers |
| `ethos serve` | No adapters. Its watcher tools store `deliver` targets in `~/.ethos/watchers/watchers.json`, and a gateway on the machine sends from them | The proposal side, `createOutboxProposalSide`: gate and reviewer, no dispatcher, no card. A `send_message` it queues is delivered by a gateway's dispatcher once approved |
| `ethos chat`, `cron`, `mcp`, `batch`, `eval`, `acp`, `bench` | None. Nothing calls `setMessagingSend` and no watcher tools are registered, so `send_message` fails with `Gateway not active` for every personality | None, because there is nothing to gate |

`apps/ethos/src/__tests__/outbox-gate-live.test.ts` pins every row: it checks the wiring in the first two rows, and fails if either seam appears in a command that builds no outbox.

A gate that throws refuses the send: `gateSend` converts any error from `gates`, `ownerTarget` or `propose` into an `execution_failed` tool result reading "Nothing was sent." It never falls through to the adapter.

## Subpages {#subpages}

| Section | Page |
| --- | --- |
| <a id="lifecycle"></a>[Lifecycle](outbound-policy/lifecycle.md#lifecycle) | [Outbound policy: lifecycle, content binding and sender resolution](outbound-policy/lifecycle.md) |
| <a id="binding"></a>[The content binding](outbound-policy/lifecycle.md#binding) | [Outbound policy: lifecycle, content binding and sender resolution](outbound-policy/lifecycle.md) |
| <a id="sender"></a>[Sender resolution](outbound-policy/lifecycle.md#sender) | [Outbound policy: lifecycle, content binding and sender resolution](outbound-policy/lifecycle.md) |
| <a id="reviewer"></a>[Reviewer](outbound-policy/review-and-delivery.md#reviewer) | [Outbound policy: reviewer, delivery, windows, audit and limitations](outbound-policy/review-and-delivery.md) |
| <a id="delivery"></a>[Delivery](outbound-policy/review-and-delivery.md#delivery) | [Outbound policy: reviewer, delivery, windows, audit and limitations](outbound-policy/review-and-delivery.md) |
| <a id="windows"></a>[Fixed windows](outbound-policy/review-and-delivery.md#windows) | [Outbound policy: reviewer, delivery, windows, audit and limitations](outbound-policy/review-and-delivery.md) |
| <a id="audit"></a>[Audit trail](outbound-policy/review-and-delivery.md#audit) | [Outbound policy: reviewer, delivery, windows, audit and limitations](outbound-policy/review-and-delivery.md) |
| <a id="limitations"></a>[Limitations](outbound-policy/review-and-delivery.md#limitations) | [Outbound policy: reviewer, delivery, windows, audit and limitations](outbound-policy/review-and-delivery.md) |

## See also {#see-also}

- [Approve posts before they go out](../../using/how-to/approve-posts-before-sending.md) — the operator's walkthrough.
- [Messaging — `send_message`](messaging-tools.md) — the tool the gate lives in.
- [Personality config reference](../../using/reference/personality-yaml.md) — every other `config.yaml` field.
- [Set up approval gates for dangerous tool calls](../../using/how-to/set-up-approval-gates.md) — the in-memory tool-approval mechanism, which this deliberately is not.
- [Why voice replies redeliver](../explanation/why-voice-replies-redeliver.md) — the delivery ledger the outbox hands confirmed-less sends to.
