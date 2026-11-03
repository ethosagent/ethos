# ADR 0010 — Two checkers enforce the constitution

## Status

Accepted. Moved verbatim from ARCHITECTURE.md §IX on 2026-11-03 as a Clarifying amendment (ARCHITECTURE.md §VI). No law changed scope.

## Context

§IX says how the constitution is enforced. ARCHITECTURE.md keeps a ten-line summary, the known-gap paragraph, the generated rules table and the validator block. This record holds the full operating model and its amendment note.

## Decision

### The operating model

- **This document is the guideline.** It says why each law exists, and
  every law in §III names its enforcer or its known gap.
- **`architecture.config.ts` is the enforced projection** of §II and of
  the §III laws that can be read from imports and syntax: the layer
  table, the banned constructs, and the exceptions to them. The layer
  paths, the app entry modules and the vendored shim live there and
  nowhere else. [archcheck](https://www.npmjs.com/package/archcheck)
  checks it:
  - at **pre-commit**, on the changed files
    (`archcheck --changed --format verdict`, `lefthook.yml`);
  - at **pre-push**, on the whole repository (`archcheck`,
    `archcheck emit --check`, and the baseline-shrink check);
  - in **`pnpm test`**, through
    `packages/types/src/__tests__/archcheck.test.ts` (the live run) and
    `packages/types/src/__tests__/archcheck-fixtures.test.ts` (every
    error rule is proven to fire on a fixture in `archcheck-fixtures/`);
  - in **CI**, in the `architecture` job (SARIF upload, `emit --check`,
    and the baseline-shrink check).
- **Violations that predate archcheck** are recorded in
  `.archcheck/baseline.json`. The baseline only shrinks: a fixed finding
  makes archcheck exit 4 until `archcheck baseline --prune` runs, and a
  new or grown entry fails `scripts/check-archcheck-baseline.mjs` (pre-push
  and CI) unless the commit that grew it carries an
  `Architecture-Approved-By:` trailer.
- **Changing a rule, an exception or the baseline requires the
  maintainer's approval.** Three mechanisms hold that line: the
  `Architecture-Approved-By:` trailer, which the baseline-shrink check
  reads; CI, which refuses baseline growth without it; and the Claude
  guard hook (`scripts/guard-architecture.sh`, registered in
  `.claude/settings.json`), which blocks an agent from editing
  `architecture.config.ts`, `.archcheck/baseline.json`,
  `archcheck-fixtures/`, the archcheck gate tests, the baseline check,
  the hook itself or its registration in `.claude/settings.json`, and
  from running `baseline --write` or skipping hooks. An edit to the
  manifest itself is gated by review and the hook; no script parses a
  trailer for it.
- **`scripts/check-architecture.mjs`** is the second checker. It reads the
  YAML block below and `.architecture-state.yaml`, and checks what
  archcheck cannot express: tier completeness, the guarantee register
  against its enforcement points (both directions), claims about the
  register made elsewhere, §VIII exception shape for sidecar entries, and
  stale kernel paths. It runs in `pnpm test`
  (`packages/types/src/__tests__/architecture-rules.test.ts`).

*Amended 2026-09-26 (§VI class: Substantive).* The layer and law rules
moved out of the YAML block below into `architecture.config.ts`, enforced
by archcheck; `scripts/check-architecture.mjs` dropped its `layers` check;
`.architecture-state.yaml` dropped `layers:`, `vendored:` and
`app_entry_modules:`; and exceptions to archcheck-enforced rules moved to
the manifest (§VIII). Recorded in `CHANGELOG.md`.

## Consequences

`architecture.config.ts` and `scripts/check-architecture.mjs` never restate each other.
The baseline only shrinks, so a fixed violation must be pruned.

## Enforced by

- archcheck at pre-commit, pre-push, in `pnpm test` (`packages/types/src/__tests__/archcheck.test.ts`, `archcheck-fixtures.test.ts`) and in CI job `architecture`.
- `scripts/check-archcheck-baseline.mjs` for baseline growth; `scripts/guard-architecture.sh` for agent edits.
- `scripts/check-architecture.mjs` through `packages/types/src/__tests__/architecture-rules.test.ts`.
