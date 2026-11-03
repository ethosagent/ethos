---
title: "Outbound policy: reviewer, delivery, windows, audit and limitations"
description: "Outbound policy reviewer, delivery, windows, audit, limitations."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

Who reviews a send, how approved sends are delivered, and what the gate does not cover. Part of the [Outbound policy reference](../outbound-policy.md).

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

- **Only a gateway process delivers.** `ethos serve` queues but holds no adapters. An item it queues sits in `approved` until an `ethos gateway start` or `ethos boot` that holds the sending bot is running, and the approval expires after 24 hours. The commands with no outbox cannot publish at all — see [Where the gate is wired](../outbound-policy.md#surfaces).
- **MCP tools and `a2a_send` are not covered.** Covering them would mean classifying arbitrary third-party tools. The character sheet prints the exclusion rather than letting the field read as blanket coverage.
- **The reviewer cannot approve or block.** A human approves every publication.
- **Delivery is at-least-once.** There is no exactly-once promise anywhere on this path: the ledger redelivers, and per-adapter honesty varies — Telegram's chunked send reports `ok: true` on a partially delivered multi-chunk message.
- **A sent publication cannot be unsent.** Ethos offers no recall; the web pane says so and points at the platform.
- **A watcher with no recorded owner is never re-checked.** `WatcherManager.dispatchChange` re-asks the gate on every change, so a watcher stored before the policy was switched on stops delivering to a foreign chat. It can ask only about a record that names the personality that created it (`WatcherRecord.owner`). Watchers created before owners were recorded carry none and still deliver. The watcher tools show and change only the calling personality's own watchers (`loadOwnedWatcher` in `extensions/tools-watchers/src/index.ts`), so no agent can delete an ownerless one: remove its entry from `~/.ethos/watchers/watchers.json` and recreate it from the personality that should own it.
- **Approval cards exist on Telegram only, and only from the process holding the sending bot.** `postOutboxCard` / `updateOutboxCard` / `onOutboxDecision` are implemented by `TelegramAdapter` alone, and `createOutboxApprovalSurface` posts a card only through the item's own bot's adapter. A publication on Slack or WhatsApp, or any item queued under `ethos serve`, gets no card: approve it in the web pane or with `ethos outbox approve <id> --revision <n>`.
- **On the web, any authenticated `/rpc` session counts as the operator** (the rule `deliveries` already rides on). `clientId` on an approve is a label for the audit trail, not a gate.
- **Publications land at the chat root.** `send_message` has no thread parameter, so `threadId` is always absent on a proposal.
- **`channels` is validated only when `approve_before_send` is present.** A `config.yaml` with `outbound_policy.channels` and no `outbound_policy.approve_before_send` parses to nothing, gates nothing, and reports no unknown name.
- **An approved-but-unsent item counts as busy** for the idle watcher (`pendingPublications` counts `approved` and `sending`). `awaiting_approval` deliberately does not — a machine that cannot suspend while a person thinks would never suspend.

## See also {#see-also}

- [Outbound policy reference](../outbound-policy.md): the index of every section and its page.
