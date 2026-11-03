---
title: "Security controls: channel-level controls"
description: "Channel allowlist, DM pairing, mention-gate and context-visibility filter."
kind: reference
audience: shared
updated: 2026-11-03
---

## Synopsis {#synopsis}

Channel allowlist, one-time DM pairing, mention-gate and the context-visibility filter. Part of the [Security controls](../controls.md).

## Channel-level controls {#channel-level-controls}

A channel adapter is the front door. If anyone who knows your bot's handle can DM it, every other layer has to clean up after the first compromise.

Channel controls are operator settings, one block per platform under `channel_filter.<platform>.*` in `~/.ethos/config.yaml`. They are not personality fields. A platform with no `channel_filter` block admits every sender (`checkMessage` returns `allow` when the platform has no config).

### Channel allowlist {#channel-allowlist}

*Status: Shipped.*

Per-platform sender allowlists: the platform's `ownerUserId` plus `recipientAllowlist`. An entry is an exact sender id (a Telegram numeric user ID, a Discord snowflake, a Slack `U…` ID) or, for email, a leading-`*` suffix pattern such as `*@example.com` (`matchesGlob`, which handles only a leading wildcard).

A non-allowlisted sender in a group is dropped. A non-allowlisted sender in a DM follows `dmPolicy`: `pairing` (the default) answers with a pairing code instead of passing the message to the [agent loop](../../getting-started/glossary.md#agent-loop); `decline` answers with one fixed refusal per sender per 24 hours and never runs a turn; `allowlist`, `reject`, `silent-drop` and `queue` all drop it. A refusal is suppressed, and the 24-hour window left unspent, inside quiet hours or a `/mute`, and it is never sent to a DM marked as reaching more than one person. Enforced by `checkMessage` (`decline_reply`), `claimDeclineSlot` (`packages/safety/channel/src/decline-store.ts`) and the gateway's `decline_reply` branch in `dispatchInbound` (`extensions/gateway/src/index.ts`); pinned by `extensions/gateway/src/__tests__/dm-decline.test.ts`.

- Source: `checkMessage` in `packages/safety/channel/src/channel-filter.ts`
- Tests: `packages/safety/channel/src/__tests__/channel-filter.test.ts`
- Audit: a drop is recorded as `audit.block` by the gateway, code `channel.allowlist.blocked` for a DM and `channel.mention_gate` for any group drop (`extensions/gateway/src/index.ts`). An admitted message records nothing. `channel.allow` is recorded when an owner approves a pairing code (code `channel.pairing.approved`); `channel.deny` when an owner runs `/deny` (code `channel.allowlist.removed`).

### One-time DM pairing codes {#one-time-dm-pairing-codes}

*Status: Shipped.*

An unknown sender who DMs the bot on a platform with `dmPolicy: pairing` receives a one-time code (`generateCode`, called from `checkMessage`). The **owner** redeems it to approve that sender: `/allow <code>` in the gateway, or `/allow <code>` in the chat REPL (`runPairingCommand` in `apps/ethos/src/commands/pairing-commands.ts`). The sender does not redeem the code.

| Property | What the code does | Enforced by |
|---|---|---|
| Bound to one sender | The code row stores the `sender_id` and platform it was issued for; redemption approves exactly that sender | `consumeAndAllow` in `packages/safety/channel/src/pairing-store.ts` |
| Owner-only redemption (gateway) | `/allow` is refused unless the caller is the code platform's `ownerUserId` | `senderIsOwner` check in the gateway's `/allow` handler, `extensions/gateway/src/index.ts` |
| Random | 8 random bytes (`randomBytes(8)`), hashed to an 8-character code. Uniqueness rests on the table's primary key; a collision throws rather than retrying | `generateCode`, `makeCode` |
| Expires | One hour | `CODE_TTL_MS` |
| Single use | The `pending → consumed` flip and the allowlist insert run in one transaction; a replay finds `consumed` | `consumeAndAllow` |
| Issue rate limit | One pending code per sender per platform per 10 minutes; further DMs in that window are dropped | `generateCode` (`RATE_LIMIT_WINDOW_MS`) |
| Redeem rate limit | 5 failed redemptions per owner in 10 minutes, or 20 failed redemptions globally, pauses that owner for 24 hours | `recordFailedAttempt` (`LOCKOUT_THRESHOLD`, `GLOBAL_LOCKOUT_THRESHOLD`, `LOCKOUT_DURATION_MS`) |

The redeem rate limit applies only when an owner id is passed, which the gateway does. The chat REPL's `/allow` passes none, because the person at the REPL is the operator.

- Tests: `packages/safety/channel/src/__tests__/pairing-store.test.ts`
- Audit category: `channel.pairing`, recorded by the gateway (`Gateway.recordPairing` → `recordChannelPairing`, `extensions/gateway/src/index.ts`) with code `channel.pairing.issued` when a code is issued and `channel.pairing.redeem_failed` when an `/allow` fails. The outcome is one of `issued`, `not_owner`, `not_found`, `consumed`, `expired`, `sender_mismatch` or `owner_paused`; the code itself is never recorded. A rate-limited issue writes no `channel.pairing` event — it shows only as the `channel.allowlist.blocked` drop. A successful approval, including `/communications approve-all`, records `channel.allow` (code `channel.pairing.approved`). Pinned by `extensions/gateway/src/__tests__/pairing-audit.test.ts`.
- Limitation: the chat REPL's `/allow` (`runPairingCommand`) does not go through the gateway and writes no audit event — neither `channel.pairing` on failure nor `channel.allow` on success.

### Mention-gate (groups only) {#mention-gate}

*Status: Shipped.*

In a group, an allowlisted sender's message is dropped unless it mentions the bot. Drive-by hijacking by pasting a wall of text into a public channel doesn't reach the LLM at all. The owner bypasses the gate, so `/allow` works from any channel; non-owners cannot.

- Source: step 6 of `checkMessage` in `packages/safety/channel/src/channel-filter.ts`

### Context-visibility filter {#context-visibility-filter}

*Status: Shipped.*

Two separate mechanisms handle content the user did not author.

**Provenance marking.** The gateway wraps every admitted inbound message with `wrapUntrusted` before the agent loop sees it: the message text as `channel_message`, and any adapter-supplied channel history as `channel_history` (`extensions/gateway/src/index.ts`). This applies whatever `contextVisibility` says. Nothing handles forwarded content as a separate case.

**Visibility filter.** `channel_filter.<platform>.contextVisibility` removes content from non-allowlisted senders:

| Mode | Behaviour |
|---|---|
| `all` (default) | Nothing removed. |
| `allowlist` | When the message replies to a non-allowlisted sender (`replyToUserId` set and not on the allowlist), `>`-quoted lines are stripped. Channel history keeps only lines whose author is allowlisted; history the adapter did not attribute per line is dropped whole (`filterPriorContext`). If the adapter does not supply `replyToUserId`, quoted lines are kept. |
| `allowlist_quote` | Alias of `allowlist`. Same behaviour. |

- Source: step 7 of `checkMessage` in `packages/safety/channel/src/channel-filter.ts`

## See also {#see-also}

- [Security controls](../controls.md) — the index page for this reference.
