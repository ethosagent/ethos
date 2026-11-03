# ADR 0007 — Decision providers are thin adapters that return data, not text

## Status

Accepted. Moved verbatim from ARCHITECTURE.md §IV on 2026-11-03 as a Clarifying amendment (ARCHITECTURE.md §VI). No law changed scope.

## Context

The decision provider contract (`packages/types/src/decision.ts`) answers typed questions with probabilities. It writes no text, so it sits beside the LLM provider contract and does not implement it.

## Decision

### Decision Provider Authoring

A decision provider answers typed questions about a piece of state and
returns typed values with probabilities. It writes no text, so it is a
sibling of the LLM provider contract, not an implementation of it. A new
decision provider is a thin adapter over a transport function, in its own
package at `extensions/decision-<vendor>/`. The provider maps the
contract's request onto the vendor's wire format and the vendor's response
back onto the contract; the transport function is the only code that
touches the wire.

- **One request per call.** `decide` makes at most one request and never
  retries. A rate-limit or overload status returns its code at once.
  Fallback belongs to the call site, which owns its fail direction; the
  provider owns only how it fails.
- **Errors are data.** `decide` never throws. Every failure is
  `{ ok: false, code, message }` with one of ten codes: `auth`,
  `invalid`, `rate_limited`, `overloaded`, `timeout`, `aborted`,
  `malformed`, `too_large`, `unavailable`, `breaker_open`. A network
  failure or an unmapped status is `unavailable`; `breaker_open` means
  the provider's own breaker refused the call and sent nothing. A missing or mistyped answer is
  `malformed`, never a defaulted value.
- **Question names are provider-neutral.** The contract's question types
  are `boolean`, `choice` and `score`. A vendor's wire names appear only
  inside that vendor's package.
- **Confidence is uniform.** Every answer carries a `confidence` in 0..1.
  Where the vendor returns none, the adapter derives one (for a boolean,
  `|2p − 1|`), so every call site thresholds the same way.
- **A breaker may only remove influence.** A provider that keeps failing
  may stop calling the network for a cool-down; while it does, `decide`
  returns an error code and the call site takes its fallback. The breaker
  lives in the extension and never produces an answer.
- **Redaction, thresholds and shadow mode are not the provider's.** They
  live in Tier 0 wiring, `runDecisionSite` in
  `packages/wiring/src/decision-site.ts`, which redacts the state before
  `decide`, acts on an answer only at or above the site's confidence
  threshold, and in shadow mode records the answer without acting on it.
  An extension cannot relax them (Law 11).

**Transport table:**

| Transport | Package | Wire protocol |
|---|---|---|
| `postSystemOne` | `@ethosagent/decision-typesafe` | TypeSafe `/v1/systemone` |

## Consequences

Fallback, redaction, thresholds and shadow mode stay in wiring. A vendor package cannot relax them (Law 11).
Every failure is a value, so a call site never needs a try block around `decide`.

## Enforced by

- `packages/types/src/__tests__/decision-provider-method-count.test.ts` pins the contract surface.
- `runDecisionSite` in `packages/wiring/src/decision-site.ts` applies redaction, the confidence threshold and shadow mode.
- Not mechanically enforced (known gap): the one-request, no-retry and no-throw rules inside a vendor package.
