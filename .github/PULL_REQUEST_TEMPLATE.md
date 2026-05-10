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
