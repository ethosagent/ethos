# ADR 0008 — Frozen-schema bump rules and forbidden fields

## Status

Accepted. Moved verbatim from ARCHITECTURE.md §VII on 2026-11-03 as a Clarifying amendment (ARCHITECTURE.md §VI). No law changed scope.

## Context

ARCHITECTURE.md §VII keeps the definition of a frozen schema and the roster table. This record holds the worked examples, the bump obligations and the categories that never become frozen-schema fields.

## Decision

Adding an **optional** method to `ContextEngine` is a §VI **Substantive** change:
it needs two-maintainer approval, the drift gate bumped in the same commit, and
a CHANGELOG entry naming the class. It does **not** bump
`PLUGIN_CONTRACT_MAJOR` — per `packages/plugin-contract/src/version.ts`, only a
field rename, a field removal, or a *required*-field addition does. Adding a
**required** method additionally breaks every engine registered out-of-tree via
`EthosPluginApi.registerContextEngine`, so it drags in the Plugin contract row
above and its contract-major bump.

Adding a **variant** to the `CompletionChunk` union is also a §VI
**Substantive** change under the LLM provider contract row. The `compaction`
variant (openclaw-9.5-adoption item 7, D31) was added that way: owner-approved,
the drift gate (`llm-provider-drift.test.ts`) moved from 8 to 9 in the same
commit and now checks the union against the `frozen_variants` manifest in §IX
as well as its own list, and a CHANGELOG entry names the class. A new variant
is additive for consumers that ignore unknown chunk types, but a consumer that
validates types against a fixed set (`checkChunkVariants` in
`packages/wiring/src/conformance/index.ts`) must learn it in the same change.
[LLM provider governance](../content/building/explanation/llm-provider-governance.md)
records the amendment and its sign-off state.

### Bump obligations

Every schema bump requires, in the same commit:

1. The owner's approval per the schema's row.
2. The drift gate updated in lockstep.
3. A migration document or CHANGELOG entry stating the obligation on
   downstream code.
4. No-overlap deprecation: removed fields are removed in the same
   release as their replacement, unless the migration document
   explicitly authorises overlap and bounds it to a single release.

### Categories that may never become frozen-schema fields

These categories belong to skills, tools, memory, or per-channel adapter
configuration. They may not become top-level fields on the personality,
plugin, or provider schemas.

- Voice, speech synthesis, audio output configuration.
- Emotion, mood, sentiment tags.
- Per-channel display affordances or response templates.
- Anything that grants the model a capability the toolset does not
  already express.

## Consequences

Every roster change ships its drift-gate bump in the same commit.
The roster stays in §VII. The `frozen_schemas:` map in the §IX validator block lists the same identities for the drift tests.

## Enforced by

- Drift gates in `packages/types/src/__tests__/`: `personality-field-count`, `llm-provider-drift`, `memory-method-count`, `context-engine-method-count`, `content-store-method-count`, `agent-card-field-count`, `pause-lifecycle-method-count`, `decision-provider-method-count`.
- `packages/types/src/__tests__/architecture-rules.test.ts` and `scripts/check-architecture.mjs` read the `frozen_schemas:` map.
- Not mechanically enforced (known gap): the forbidden-field categories.
