## Why

<!-- 1-3 sentences: what problem does this solve, why now -->

## How

<!-- Brief: what you actually did. Skip for trivial PRs. -->

## Checklist

- [ ] Conventional Commit subject (`feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `test:`)
- [ ] Ran `pnpm check` locally (or `make check`) — green
- [ ] Updated `AGENTS.md` if architecture changed
- [ ] Updated docs under `docs/content/` if a user-facing field/command changed (CI gate `config-doc-sync.test.ts` will fail otherwise)
- [ ] If frozen schema touched: added `personality-schema-change` label, bumped `.personality-field-count`, added `CHANGELOG.md` entry (see [CONTRIBUTING.md](../CONTRIBUTING.md))
- [ ] If LLM-co-authored: included `Co-Authored-By:` trailer in the commit

## Docs (only if `docs/**` or `DOCS.md` changed)

Per [DOCS.md §Page-acceptance checklist](../DOCS.md#page-acceptance-checklist). CI runs the same checks via `pnpm docs:check` (build + page-acceptance gate). Tick whatever applies — skip the section if no docs files changed.

- [ ] Front-matter declares `title`, `description`, `kind`, `audience`, and `updated`; values agree with the directory.
- [ ] Page matches the template for its `kind` (required sections present, prohibited sections absent).
- [ ] Passes the tutorial-vs-how-to test (or the why-question test for explanation).
- [ ] `description` ≤155 chars and free of marketing voice ("Learn how to", "Harness", "Unlock", "Discover", "the best way to").
- [ ] First occurrence of every domain term links to [`getting-started/glossary.md`](../docs/content/getting-started/glossary.md).
- [ ] Reference and glossary pages: every H2/H3 carries an explicit `{#kebab-id}` anchor.
- [ ] Reference pages link to a source-of-truth code path.
- [ ] "See also" footer present on reference and explanation pages (≥1, ≤5 links).
- [ ] Code samples are runnable against the current `@ethosagent/types`.
- [ ] No anti-patterns (no "Welcome to", "click here", "Coming soon", "WIP", emoji in headings).
- [ ] `pnpm --filter docs build` passes with `onBrokenLinks: 'throw'`.
- [ ] Page is reachable from at least one other page or `docs/sidebars.ts` (no orphans).
