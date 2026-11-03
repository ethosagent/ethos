# ADR 0002 — Why dependency direction is a law (Laws 1, 2, 3, 5)

## Status

Accepted. Moved verbatim from ARCHITECTURE.md §III on 2026-11-03 as a Clarifying amendment (ARCHITECTURE.md §VI). No law changed scope.

## Context

Laws 1, 2, 3 and 5 turn principles P1-P3 into import rules. ARCHITECTURE.md §III keeps each rule and its enforcer. The reasoning lives here.

## Decision

The §III preamble below now says "a one-sentence rule" and points here; the original wording is kept.

Each law is a one-sentence rule with a one-sentence rationale. Laws are
binding. Each law names what enforces it: an archcheck rule id from
`architecture.config.ts` (§IX), a test, or "not mechanically enforced
(known gap)" — a law with no enforcer is recorded as a gap, never implied
to be checked.

**Law 1 — Contracts are pure**

> Modules in the contracts layer must not depend on any other internal
> workspace package. External runtime dependencies are permitted only when
> they author the schema language itself (zod, oRPC, Protobuf-TS).

*Rationale:* a contract that imports a sibling becomes structurally
bound to it; a contract that depends on a typed-DSL library is still a
contract.

**Law 2 — Core does not import concrete implementations**

> The core layer imports contracts only. It does not import an LLM
> provider, a tool, a memory backend, a session store, a platform adapter,
> a persistence backend, or any extension that implements an injection
> seam.

*Rationale:* the engine must be swappable independent of what is
plugged into it.

**Law 3 — Wiring is the only composition root**

> Only wiring modules import concrete extensions by name and assemble them.

*Rationale:* the system's runtime topology must exist in exactly one
place.

**Law 5 — Apps do not bypass wiring**

> An app imports wiring and contracts. An app does not import a concrete
> extension directly.

*Rationale:* a second composition root re-creates
the topology and breaks the substitution model.

## Consequences

A reader who wants the rule reads §III. A reader who wants the reason reads this record.
Changing one of these laws still follows §VI. Editing this record does not.

## Enforced by

- Law 1: archcheck `l1-contracts-pure`.
- Law 2: archcheck `l2-core-no-concrete` and `packages/core/src/__tests__/no-kernel-runtime-imports.test.ts`.
- Law 3: archcheck `l3-wiring-composes` with the deny side in every other layer rule.
- Law 5: archcheck `l5-apps-through-wiring`, `app-entry-modules-compose` and `web-api-rpc-is-thin`.
