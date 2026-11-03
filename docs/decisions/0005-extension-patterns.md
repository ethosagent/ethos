# ADR 0005 — Extension patterns A-D for sibling dependencies

## Status

Accepted. Moved verbatim from ARCHITECTURE.md §IV on 2026-11-03 as a Clarifying amendment (ARCHITECTURE.md §VI). No law changed scope.

## Context

Law 4 lets extensions depend on sibling extensions. The four patterns below describe the shapes that stay healthy. A new pattern needs no amendment.

## Decision

The patterns below are operational guidance — common shapes that
healthy sibling dependencies take. They are recommendations, not
validator-enforced categories. A new pattern does not require an
amendment; it is simply a new common shape.

**Pattern A — Wrapper.**
A tool-layer extension wraps a single service-layer extension to expose
its capability to the model. The wrapper has no behaviour beyond
translating between the service and the tool contract.

**Pattern B — Safety decoration.**
An extension that crosses a trust boundary depends on the safety
extension that polices that boundary. The dependency is structural: the
boundary cannot be optional or runtime-injectable.

**Pattern C — Content bundle.**
An extension that ships static content (skills, prompts, manifests)
depends on the loader extension that interprets that content. The
root-level `skills/` package (`@ethosagent/skills-library`) is the
bundled skill library, organized into category folders
(`software-development/`, `github/`, `framework/`).
`~/.ethos/skills/` is the user's own skill directory.

**Pattern D — Protocol bridge.**
An extension that adapts an external protocol depends on the contract
module for that protocol, not on any sibling implementation of the same
protocol.

## Consequences

Patterns are guidance. A sibling edge that fits none of them is still legal under Law 4.
Pattern B ties a trust-crossing extension to the kernel module that polices the boundary (§V).

## Enforced by

- Not mechanically enforced (known gap): the patterns are recommendations, and archcheck rule `extensions-implement-contracts` allows sibling edges.
