---
title: "Outbound policy: lifecycle, content binding and sender resolution"
description: "Outbound policy approval lifecycle, content binding and sender."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

How a gated send moves from request to decision. Part of the [Outbound policy reference](../outbound-policy.md).

## Lifecycle {#lifecycle}

<figure class="ethos-figure"><div class="ethos-figure-pad"><svg viewBox="0 0 1000 330" role="img" aria-label="State diagram of the outbound publication lifecycle. propose transitions to awaiting_review, which transitions to awaiting_approval on the reviewer receipt or when stale over 10 minutes (recorded as unavailable). With no approver_personality, propose transitions directly to awaiting_approval. awaiting_approval transitions to approved via approve(rev,hash), loops back to itself via edit (revision plus 1, prior approval void), and transitions to rejected via reject(reason). approved transitions to sending via claim, back to awaiting_approval via revoke, and to expired when not claimed within 24 hours; any awaiting state older than 7 days also transitions to expired. sending transitions to sent, unconfirmed, or failed, and back to approved on a pre-send refusal. failed transitions back to approved via retry, keeping the same revision." font-family="Geist Mono,monospace">
<defs><marker id="outbox-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#70706B"/></marker></defs>
<rect x="20" y="40" width="90" height="36" rx="10" fill="#EAC98F" fill-opacity="0.08" stroke="#EAC98F"/>
<rect x="200" y="40" width="150" height="36" rx="10" fill="#9CC5F2" fill-opacity="0.08" stroke="#9CC5F2"/>
<rect x="470" y="40" width="160" height="36" rx="10" fill="#9CC5F2" fill-opacity="0.08" stroke="#9CC5F2"/>
<rect x="740" y="40" width="100" height="36" rx="10" fill="#9BDDB4" fill-opacity="0.08" stroke="#9BDDB4"/>
<rect x="330" y="170" width="100" height="36" rx="10" fill="#D8A5E8" fill-opacity="0.08" stroke="#D8A5E8"/>
<rect x="470" y="170" width="90" height="36" rx="10" fill="#EAC98F" fill-opacity="0.08" stroke="#EAC98F"/>
<rect x="740" y="170" width="100" height="36" rx="10" fill="#9BDDB4" fill-opacity="0.08" stroke="#9BDDB4"/>
<rect x="630" y="280" width="80" height="36" rx="10" fill="#9BDDB4" fill-opacity="0.08" stroke="#9BDDB4"/>
<rect x="730" y="280" width="120" height="36" rx="10" fill="#EAC98F" fill-opacity="0.08" stroke="#EAC98F"/>
<rect x="880" y="280" width="80" height="36" rx="10" fill="#D8A5E8" fill-opacity="0.08" stroke="#D8A5E8"/>
<line x1="110" y1="58" x2="196" y2="58" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<line x1="350" y1="58" x2="466" y2="58" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<line x1="630" y1="50" x2="736" y2="50" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<line x1="740" y1="66" x2="634" y2="66" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<path d="M505 40 C505 12 595 12 595 40" fill="none" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<path d="M65 76 V118 H500 V78" fill="none" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<path d="M480 76 V150 H380 V168" fill="none" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<line x1="515" y1="76" x2="515" y2="167" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<path d="M760 76 V120 H540 V167" fill="none" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<line x1="805" y1="76" x2="805" y2="167" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<line x1="775" y1="170" x2="775" y2="79" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<path d="M790 206 V240 H670 V277" fill="none" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<line x1="790" y1="206" x2="790" y2="277" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<path d="M790 206 V240 H920 V277" fill="none" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<path d="M960 298 H980 V58 H844" fill="none" stroke="#70706B" marker-end="url(#outbox-arrow)"/>
<g font-size="13" fill="var(--ethos-text-primary)">
<text x="65" y="62" text-anchor="middle">propose</text>
<text x="275" y="62" text-anchor="middle">awaiting_review</text>
<text x="550" y="62" text-anchor="middle">awaiting_approval</text>
<text x="790" y="62" text-anchor="middle">approved</text>
<text x="380" y="192" text-anchor="middle">rejected</text>
<text x="515" y="192" text-anchor="middle">expired</text>
<text x="790" y="192" text-anchor="middle">sending</text>
<text x="670" y="302" text-anchor="middle">sent</text>
<text x="790" y="302" text-anchor="middle">unconfirmed</text>
<text x="920" y="302" text-anchor="middle">failed</text>
</g>
<g font-size="11" fill="var(--ethos-text-secondary)">
<text x="550" y="10" text-anchor="middle">edit (revision+1, prior approval void)</text>
<text x="385" y="30" text-anchor="middle">receipt | stale &gt;10m: "unavailable"</text>
<text x="684" y="30" text-anchor="middle">approve(rev,hash)</text>
<text x="684" y="90" text-anchor="middle">revoke</text>
<text x="200" y="108" text-anchor="middle">(no approver_personality)</text>
<text x="490" y="106" text-anchor="end">awaiting_* older than 7d</text>
<text x="430" y="145" text-anchor="middle">reject(reason)</text>
<text x="650" y="136" text-anchor="middle">approved not claimed within 24h</text>
<text x="813" y="125">claim</text>
<text x="767" y="155" text-anchor="end">pre-send refusal</text>
<text x="972" y="178" text-anchor="middle" transform="rotate(-90 972 178)">retry (same rev)</text>
</g>
</svg></div><figcaption>The outbound publication lifecycle: propose flows through review and approval to sending and a terminal state, with edit, revoke, expiry, and retry transitions preserved.</figcaption></figure>

| State | Meaning |
|---|---|
| `awaiting_review` | The advisory reviewer is running. No human has seen it. |
| `awaiting_approval` | In front of a human, with the reviewer's receipt if there is one. |
| `approved` | A human approved this revision. The gateway dispatcher has not claimed it yet, so it can still be revoked. |
| `sending` | Claimed by a dispatcher and in flight. |
| `sent` | The platform confirmed. |
| `unconfirmed` | Handed to the delivery ledger, no confirmation. The [delivery obligation](../../../getting-started/glossary.md#delivery-obligation) owns every retry from here; the outbox never resends. |
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

## See also {#see-also}

- [Outbound policy reference](../outbound-policy.md): the index of every section and its page.
