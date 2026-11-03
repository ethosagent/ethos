These records are plain Markdown for repository readers, not Docusaurus pages and not docs-skill `kind: decision` pages (those are comparison pages under `docs/content/`).

# Architecture decision records

Each record holds rationale and pattern prose moved verbatim out of [ARCHITECTURE.md](../../ARCHITECTURE.md) in a Clarifying amendment (§VI). The law, its enforcer and its `*Enforced by:*` line stay in the constitution. A record explains why; it does not change what is allowed.

Format per line: `NNNN — Title — status — one-line decision`.

0001 — [Runtime boundary: six layers, one direction](0001-runtime-boundary-layers.md) — Accepted — every module belongs to one layer and imports only downward; membership follows role, not directory.
0002 — [Why dependency direction is a law (Laws 1, 2, 3, 5)](0002-law-rationale-dependency-direction.md) — Accepted — contracts stay pure, core stays swappable, one composition root, apps go through wiring.
0003 — [Why extensions, storage and the toolset are laws (Laws 4, 7, 8)](0003-law-rationale-extensions-storage-tools.md) — Accepted — sibling extension edges are legal, Storage guards only the personality boundary, the registry filters by toolset.
0004 — [Why personality, import style, silence and kernel guarantees are laws (Laws 6, 9, 10, 11)](0004-law-rationale-schema-style-kernel.md) — Accepted — the schema defines the personality, imports omit extensions, libraries log through `Logger`, no outside module weakens a kernel guarantee.
0005 — [Extension patterns A-D for sibling dependencies](0005-extension-patterns.md) — Accepted — wrapper, safety decoration, content bundle and protocol bridge are guidance, not validator categories.
0006 — [LLM providers are thin adapters over a transport](0006-llm-provider-authoring.md) — Accepted — a provider never holds a streaming loop; reuse a transport or extract a new one first.
0007 — [Decision providers are thin adapters that return data, not text](0007-decision-provider-authoring.md) — Accepted — one request per call, errors as data, redaction and thresholds stay in Tier 0 wiring.
0008 — [Frozen-schema bump rules and forbidden fields](0008-frozen-schema-bump-rules.md) — Accepted — a bump moves the drift gate in the same commit; voice, emotion and display affordances never become schema fields.
0009 — [An archcheck exception entry carries the §VIII fields in its reason](0009-archcheck-exception-field-mapping.md) — Accepted — five of the eight §VIII fields fold into the single archcheck `reason` string.
0010 — [Two checkers enforce the constitution](0010-validator-operating-model.md) — Accepted — `architecture.config.ts` plus archcheck and `scripts/check-architecture.mjs` never restate each other.
