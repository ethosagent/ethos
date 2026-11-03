# ADR 0003 — Why extensions, storage and the toolset are laws (Laws 4, 7, 8)

## Status

Accepted. Moved verbatim from ARCHITECTURE.md §III on 2026-11-03 as a Clarifying amendment (ARCHITECTURE.md §VI). No law changed scope.

## Context

Laws 4, 7 and 8 say where extensions may reach, where raw filesystem access is allowed and how the tool registry filters. ARCHITECTURE.md §III keeps the rules and enforcers.

## Decision

**Law 4 — Extensions implement contracts**

> An extension is a replaceable module that implements one or more
> contracts. Extensions may depend on sibling extensions. The §IV patterns
> are guidance for healthy sibling dependencies, not validator-enforced
> categories.

*Rationale:* requiring contract mediation for every
cross-extension call has higher cost than benefit when the boundary is
not a security boundary.

**Law 7 — Storage abstraction guards the personality boundary**

> Modules that read or write user-authored files on a personality's behalf
> use the Storage contract. All other filesystem access — internal state,
> logs, pidfiles, journals, database-driver files, system paths,
> build-time tooling — may use raw `node:fs`.

*Rationale:* Storage exists
to make personality `fs_reach` enforceable; outside that boundary it
adds complexity without safety gain.

**Law 8 — Tool execution respects the personality toolset**

> The tool registry filters tool definitions presented to the model by
> personality toolset and rejects calls outside the allowlist at execution
> time. Rejected calls produce typed error results that maintain the
> model's message contract.

*Rationale:* a permissive registry undermines
the personality schema.

## Consequences

Sibling extension edges are allowed because the boundary between extensions is not a security boundary.
Raw `node:fs` stays legal outside the personality boundary, so Storage carries no cost where it adds no safety.

## Enforced by

- Law 4: archcheck `extensions-implement-contracts`. That an extension implements a contract is not mechanically enforced (known gap).
- Law 7: `apps/ethos/src/__tests__/no-raw-fs.test.ts`, `scripts/check-tool-imports.sh`, archcheck `p24-no-fsstorage-in-libraries` and `packages/types/src/__tests__/storage-construction-boundary.test.ts`.
- Law 8: `packages/core/src/__tests__/tool-registry.test.ts`.
