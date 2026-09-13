---
title: "outbound_policy — the approval outbox"
description: "The outbound_policy personality field: its three sub-keys, the send_message gate, the publication lifecycle, the content binding, and what is not covered."
kind: reference
audience: developer
slug: outbound-policy
updated: 2026-09-13
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
| Web approval surface | [`packages/web-contracts/src/router.ts`](https://github.com/ethosagent/ethos/blob/main/packages/web-contracts/src/router.ts) (`outbox.*`), [`apps/web-api/src/services/outbox.service.ts`](https://github.com/ethosagent/ethos/blob/main/apps/web-api/src/services/outbox.service.ts), [`apps/web/src/pages/Outbox.tsx`](https://github.com/ethosagent/ethos/blob/main/apps/web/src/pages/Outbox.tsx) |

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
| `approver_personality` | personality id | absent | An advisory reviewer that reads the draft before the human does. It can neither approve nor block — see [Reviewer](#reviewer). |

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

## Lifecycle {#lifecycle}

```
propose ─► awaiting_review ─(receipt | stale >10m: "unavailable")─► awaiting_approval
propose ─► awaiting_approval                     (no approver_personality)
awaiting_approval ─approve(rev,hash)─► approved ─claim─► sending ─► sent | unconfirmed | failed
awaiting_approval ─edit─► awaiting_approval      (revision+1, prior approval void)
awaiting_approval ─reject(reason)─► rejected     awaiting_* older than 7d ─► expired
approved ─revoke─► awaiting_approval             approved not claimed within 24h ─► expired
sending ─(pre-send refusal)─► approved           failed ─retry─► approved (same rev)
```

| State | Meaning |
|---|---|
| `awaiting_review` | The advisory reviewer is running. No human has seen it. |
| `awaiting_approval` | In front of a human, with the reviewer's receipt if there is one. |
| `approved` | A human approved this revision. The gateway dispatcher has not claimed it yet, so it can still be revoked. |
| `sending` | Claimed by a dispatcher and in flight. |
| `sent` | The platform confirmed. |
| `unconfirmed` | Handed to the delivery ledger, no confirmation. The [delivery obligation](../../getting-started/glossary.md#delivery-obligation) owns every retry from here; the outbox never resends. |
| `failed` | Nothing was sent and a human decides again. `retry` re-approves the same revision. |
| `rejected` | A human refused it. Terminal. |
| `expired` | One of the two fixed windows lapsed. Terminal. |

`LEGAL_FROM` in [`extensions/outbox/src/service.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/outbox/src/service.ts) is the single declaration of which action may be taken from which state; the table test in `extensions/outbox/src/__tests__/service.test.ts` walks every (state, action) pair and asserts the service refuses the ones not listed. A refusal is `illegal_transition` when the action was never available, and `conflict` ("changed since you viewed it") when it was and something moved underneath the caller.

Revisions are immutable rows in `outbox_revisions`. Only the text is editable; destination and sender are fixed at propose. To publish somewhere else, reject the item and let the agent propose again.

A repeat proposal with the same `(personalityId, contentHash)` while an earlier item is still active returns the existing item instead of creating a second one (`SQLiteOutboxStore.propose`). That is idempotent proposal — a model retrying its tool call does not put two cards in front of the same person — not outbound dedup.

## The content binding {#binding}

`content_hash` is the sha256 of a canonical JSON object with sorted keys:

```ts
// extensions/outbox/src/hash.ts — canonicalizeContent
{ botKey, chatId, personalityId, platform, text, threadId, v: 1 }
```

`text` is byte-exact: not trimmed, not normalized, anywhere on the path. Attachments are absent rather than optional — no gated path can carry one — and adding them bumps the version to `v: 2` over each file's sha256 of bytes.

Three places enforce the binding:

1. **Approve** is one conditional `UPDATE … WHERE id = ? AND revision = ? AND content_hash = ? AND state = 'awaiting_approval'` (`SQLiteOutboxStore.approve`). Zero rows changed means the caller gets `conflict` rather than publishing text nobody approved.
2. **An edit** writes revision n+1 with a new hash and clears `approved_by` / `approved_at` / `approved_revision` in the same UPDATE (`SQLiteOutboxStore.edit`), so an approval cannot survive into the next revision.
3. **Immediately before delivery**, `OutboxService.verifyBinding` recomputes the hash from the stored revision on the claimed row. A mismatch marks the item `failed` with `binding mismatch` and nothing is sent.

## Sender resolution {#sender}

`resolveSender` (`apps/ethos/src/lib/outbox-wiring.ts`) decides once, at propose time, which bot will speak. The candidates are the bots on the target platform bound to the personality, directly or through a team manifest.

| Candidates | Outcome |
|---|---|
| 0 | Refused: `CRON_TARGET_NOT_ALLOWED: no <platform> bot is bound to personality "<id>" — nothing was queued and nothing was sent.` |
| 1 | That bot. |
| More than 1, and the lane's botKey is among them | The lane's bot. The lane key is `${platform}:${botKey}:${chatId}`, parsed by `laneSenderBotKey` / `laneKeyBotKey`. |
| More than 1, no usable lane | Refused as an ambiguous sender. There is no fallback to "the first configured bot". |

## Reviewer {#reviewer}

`approver_personality` names a personality that runs one ordinary turn on the process's system loop before the human sees the item.

- **Advisory only.** Every path out of `createOutboxReviewer` ends with a receipt attached and the item in `awaiting_approval` in front of a person. There is no transition from a verdict to `approved`: `LEGAL_FROM.approve` admits only `awaiting_approval`, and `attachReview` always sets `awaiting_approval`.
- **Read-only toolset.** `OUTBOX_REVIEW_TOOLS` is `read_file`, `memory_read`, `team_memory_read`, `team_memory_search`, `session_search`, passed as `toolsetNarrow` (narrow can only subtract). `send_message` is absent.
- **Session key** `outbox-review:<id>:<rev>`, excluded from the learning inbox via `LEARNING_EXCLUDED_KEY_PREFIXES`.
- **The draft is untrusted data.** `buildOutboxReviewPrompt` wraps it with `wrapUntrusted` before it reaches the reviewer's context.

| Verdict | Set when |
|---|---|
| `pass` | `PASS` is the first word of the first line of the answer. |
| `fail` | `FAIL` is the first word of the first line. The item still reaches the human. |
| `unclear` | Anything else, including an empty answer. Never coerced into `pass` or `fail`; the answer is shown verbatim. |
| `unavailable` | No reviewer named, the approver id is not a personality on this machine, no loop, a missing revision, a thrown review turn, or a review that has not come back within the stale threshold. |

A human edit does not re-run the review. The receipt keeps the revision it read, and the card prefixes it with `(reviewed revision n)` when that is no longer the current one.

## Delivery {#delivery}

The dispatcher (`createOutboxDispatcher`) runs in the process that holds adapters, once after `adapter.start()` and then every `OUTBOX_POLL_INTERVAL_MS` (5 s) on an unref'd timer. Each tick expires, reconciles, claims and delivers — in that order.

Claiming is a conditional `UPDATE … WHERE id = ? AND state = 'approved'` over `listClaimable(botKeys)`, which is itself filtered to this process's bots, so two gateways sharing one `outbox.db` each take a given row exactly once.

`Gateway.deliverPublication` then refuses or sends:

| Refusal code | Meaning | What the dispatcher does |
|---|---|---|
| `bot_not_served` | This process does not hold that bot. | Releases the claim; the item returns to `approved`. |
| `no_adapter` | No adapter on that platform for that bot. A sibling bot must not publish in its place. | Releases the claim. |
| `no_binding_check` | No `publicationSpeaksFor` is wired. A publication is not sent on the assumption that its bot is still bound. | Releases the claim. |
| `not_bound` | The bot no longer speaks for the personality. The approval named that bot, so the approval itself is stale. | Marks the item `failed`. |
| `deduplicated` | Identical bytes already passed the outbound chokepoint under `outbox:<id>` inside the dedup TTL. | Releases the claim; a later tick gets through once the TTL lapses. |

On no refusal it calls `sendTrackedDetailed` with ledger session `outbox:<id>` and the byte-exact approved revision. `confirmed: true` marks the item `sent`. `confirmed: false` with an obligation id marks it `unconfirmed`, and the ledger's `sweepPendingDeliveries` owns the retry from then on. `confirmed: false` with no obligation id (no ledger wired) marks it `failed`, because saying `unconfirmed` would promise a sweep that cannot happen.

A stale `sending` row — claimed more than 10 minutes ago by a process that is gone — is reconciled against the ledger, which is the only thing that knows what happened: `DeliveryLedger.findBySession('outbox:<id>')` returning a row means `unconfirmed`; no row proves the platform call was never reached (`sendTracked` writes the obligation first), so the item becomes `failed` and waits for a human's Retry.

## Fixed windows {#windows}

Module constants in `extensions/outbox/src/store.ts`. Not configuration, and there is no config key that changes them.

| Constant | Value | Measured from |
|---|---|---|
| `PENDING_EXPIRY_MS` | 7 days | `created_at` — a reviewer receipt or an edit does not restart the clock. |
| `APPROVAL_VALIDITY_MS` | 24 hours | `approved_at` — an approval nobody delivered inside the window expires. |
| `STALE_THRESHOLD_MS` | 10 minutes | `updated_at` for a review, `claimed_at` for a `sending` row. |

## Audit trail {#audit}

`OutboxService` writes one `recordSafetyApproval` row per human decision, with codes `outbox.approve`, `outbox.reject`, `outbox.edit`, `outbox.revoke` and `outbox.retry` (`OUTBOX_AUDIT_CODES`). `approve` and `retry` record as `approved`; `reject`, `edit` and `revoke` record as `denied`, separated by their code. The details carry the content hash, never the text.

Every surface that decides passes the sink: web-api's `OutboxService` (`apps/web-api/src/index.ts`), the runtimes in `gateway.ts` and `boot.ts` (a Telegram tap), `ethos serve`, and `ethos outbox` (`runOutbox`). The gateway, boot and serve sinks are pinned by `apps/ethos/src/__tests__/outbox-gate-live.test.ts`. The sink is optional in `OutboxService` itself and fail-open, so a broken sink costs an audit row, never a decision.

## Limitations {#limitations}

Each of these is a fact about the shipped code, not a caveat about intent.

- **Only a gateway process delivers.** `ethos serve` queues but holds no adapters. An item it queues sits in `approved` until an `ethos gateway start` or `ethos boot` that holds the sending bot is running, and the approval expires after 24 hours. The commands with no outbox cannot publish at all — see [Where the gate is wired](#surfaces).
- **MCP tools and `a2a_send` are not covered.** Covering them would mean classifying arbitrary third-party tools. The character sheet prints the exclusion rather than letting the field read as blanket coverage.
- **The reviewer cannot approve or block.** A human approves every publication.
- **Delivery is at-least-once.** There is no exactly-once promise anywhere on this path: the ledger redelivers, and per-adapter honesty varies — Telegram's chunked send reports `ok: true` on a partially delivered multi-chunk message.
- **A sent publication cannot be unsent.** Ethos offers no recall; the web pane says so and points at the platform.
- **A watcher with no recorded owner is never re-checked.** `WatcherManager.dispatchChange` re-asks the gate on every change, so a watcher stored before the policy was switched on stops delivering to a foreign chat. It can ask only about a record that names the personality that created it (`WatcherRecord.owner`). Watchers created before owners were recorded, or outside an agent turn, carry none and still deliver: delete and recreate them.
- **Approval cards exist on Telegram only, and only from the process holding the sending bot.** `postOutboxCard` / `updateOutboxCard` / `onOutboxDecision` are implemented by `TelegramAdapter` alone, and `createOutboxApprovalSurface` posts a card only through the item's own bot's adapter. A publication on Slack or WhatsApp, or any item queued under `ethos serve`, gets no card: approve it in the web pane or with `ethos outbox approve <id> --revision <n>`.
- **On the web, any authenticated `/rpc` session counts as the operator** (the rule `deliveries` already rides on). `clientId` on an approve is a label for the audit trail, not a gate.
- **Publications land at the chat root.** `send_message` has no thread parameter, so `threadId` is always absent on a proposal.
- **`channels` is validated only when `approve_before_send` is present.** A `config.yaml` with `outbound_policy.channels` and no `outbound_policy.approve_before_send` parses to nothing, gates nothing, and reports no unknown name.
- **An approved-but-unsent item counts as busy** for the idle watcher (`pendingPublications` counts `approved` and `sending`). `awaiting_approval` deliberately does not — a machine that cannot suspend while a person thinks would never suspend.

## See also {#see-also}

- [Approve posts before they go out](../../using/how-to/approve-posts-before-sending.md) — the operator's walkthrough.
- [Messaging — `send_message`](messaging-tools.md) — the tool the gate lives in.
- [Personality config reference](../../using/reference/personality-yaml.md) — every other `config.yaml` field.
- [Set up approval gates for dangerous tool calls](../../using/how-to/set-up-approval-gates.md) — the in-memory tool-approval mechanism, which this deliberately is not.
- [Why voice replies redeliver](../explanation/why-voice-replies-redeliver.md) — the delivery ledger the outbox hands confirmed-less sends to.
