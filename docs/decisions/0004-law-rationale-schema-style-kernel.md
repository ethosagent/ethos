# ADR 0004 — Why personality, import style, silence and kernel guarantees are laws (Laws 6, 9, 10, 11)

## Status

Accepted. Moved verbatim from ARCHITECTURE.md §III on 2026-11-03 as a Clarifying amendment (ARCHITECTURE.md §VI). No law changed scope.

## Context

Laws 6, 9, 10 and 11 cover the personality schema, the import style, library output and the kernel guarantee. ARCHITECTURE.md §III keeps the rules, the enforcers and the Law 11 no-exception sentence.

## Decision

**Law 6 — Personality is schema-bound**

> A personality's behaviour is fully determined by the fields of the
> frozen personality schema. Code does not read personality identity from
> prompt text, filename heuristics, or any unschematised source.

*Rationale:* personality is the framework's primary axis of variation;
if the schema does not express a capability, the framework does not
honour it.

**Law 9 — Imports are extensionless internally**

> Internal relative imports omit the file extension.

*Rationale:* the
codebase runs without a build step in development; extensionful imports
break that contract and force a build dependency on every contributor.

**Law 10 — Library code is silent**

> Library code outside designated app entry points uses the `Logger`
> contract for all output. `console.*` is permitted only in app entry
> modules and in build/test tooling.

*Rationale:* silent libraries
compose; chatty libraries pollute every embedder.

**Law 11 — Kernel guarantees are not weakenable from outside**

> A module outside the security kernel must not be able to weaken a
> guarantee the kernel enforces.

*Rationale:* a guarantee an extension can
switch off was never a guarantee, and the failure is silent — which is
how a shipped control claim survived in the documentation after the code
stopped implementing it.

## Consequences

Law 11 has no exception path under §VIII, and that sentence stays in §III.
Law 9 has no mechanical enforcer. §III records it as a known gap.

## Enforced by

- Law 6: `packages/types/src/__tests__/personality-field-count.test.ts` for the schema half. That no code reads identity from prompt text is not mechanically enforced (known gap).
- Law 9: not mechanically enforced (known gap).
- Law 10: archcheck `l10-silent-libraries`.
- Law 11: `packages/core/src/__tests__/safety-conformance.test.ts`, and the `exceptions` check in `scripts/check-architecture.mjs` for the no-exception half.
