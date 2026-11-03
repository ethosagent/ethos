# ADR 0001 — Runtime boundary: six layers, one direction

## Status

Accepted. Moved verbatim from ARCHITECTURE.md §II on 2026-11-03 as a Clarifying amendment (ARCHITECTURE.md §VI). No law changed scope.

## Context

ARCHITECTURE.md §II gives the layer diagram. This record holds the prose that defines each layer, so §II stays a one-screen mental model.
Principle P2 (dependency direction is one-way) needs a fixed set of layers. Each module belongs to exactly one.

## Decision

The layer roles below were §II prose around the diagram. The diagram, the security-kernel paragraph and the app wiring adapter paragraph stay in ARCHITECTURE.md §II.

**Contracts** are the floor: pure TypeScript interfaces, value types,
discriminated unions. They have no internal dependencies. Everything
else depends on them.

**Core** is the framework engine: the agent loop, the registries, the
default context engines, and the enforcement points at which the §V
safety primitives are applied. Core depends on contracts only.

**Extensions** are concrete implementations of contracts: providers,
tools, memory backends, platform adapters, persistence stores, content
bundles. Extensions depend on contracts, on the security kernel, and on
core; they do not assume the presence of sibling extensions outside the
patterns in §IV.

**Wiring** is the composition layer: the only layer that imports
extensions by name, assembles them into a running system, and binds a
security-kernel implementation to the seam core is constructed with.

**Apps** are user-facing entry points: CLIs, TUIs, web clients, IDE
extensions, protocol servers. Apps drive wiring; they do not bypass it.

The layering is total: every module the framework owns belongs to
exactly one layer, and its imports are constrained by the layer's
position in this diagram.

A module that opens a network listener or otherwise serves a protocol is
an app, regardless of which workspace directory it currently occupies.

Layer membership is determined by role, not by directory. The
operational state of the codebase may diverge from layer boundaries
during a refactor; the constitution describes the target.


An app belongs in this monorepo only if it is a first-party Ethos
surface. Third-party integrations live in their own repositories against
the published contracts.

## Consequences

Layer membership follows role, so a module that serves a protocol is an app wherever it lives.
The constitution describes the target. A refactor may leave the codebase out of step for a while.
A change to which layers exist is a Structural amendment under §VI.

## Enforced by

- archcheck `l1-contracts-pure`, `l2-core-no-concrete`, `l3-wiring-composes`, `l5-apps-through-wiring`, `extensions-implement-contracts`, `kernel-reads-contracts` and `app-entry-modules-compose`, declared in `architecture.config.ts`.
- `packages/core/src/__tests__/no-kernel-runtime-imports.test.ts` for the core-to-kernel seam.
- Not mechanically enforced (known gap): that layer membership follows role, not directory.
