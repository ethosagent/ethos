# ADR 0009 — An archcheck exception entry carries the §VIII fields in its reason

## Status

Accepted. Moved verbatim from ARCHITECTURE.md §VIII on 2026-11-03 as a Clarifying amendment (ARCHITECTURE.md §VI). No law changed scope.

## Context

§VIII defines the required fields, the forbidden shapes, the expiry rule and where exceptions live, and ARCHITECTURE.md keeps all of that. This record holds the one part it no longer carries: how the §VIII fields map onto an archcheck entry.

## Decision

- **Exceptions to a rule archcheck enforces** live in
  `architecture.config.ts` `exceptions:` and nowhere else. archcheck's
  entry has four fields, so the §VIII fields map onto them: `scope` →
  `path` (one exact file, never a glob); `review_by` → `expires` (archcheck
  fails the run and names the owner once it passes); `owner` → `owner`;
  `id`, `law`, `created`, `reason` and `removal_condition` → `reason`,
  written as `EX-NNN (<law>, created <date>): <why, citing the code that
  justifies it>. Removal condition: <observable condition>.`

## Consequences

An archcheck entry carries four fields, so five §VIII fields fold into its `reason` string.
One file holds each entry, so an exception is never half-recorded.

## Enforced by

- archcheck fails the run once an entry in `architecture.config.ts` passes `expires`.
- The `exceptions` check in `scripts/check-architecture.mjs` validates the shape of sidecar entries in `.architecture-state.yaml`.
