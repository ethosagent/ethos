# @ethosagent/catalog

## Purpose

The unified catalog index: one typed `CatalogEntry` per reviewed capability, one TS file per entry under `src/entries/<kind>/<id>.ts` and a hand-kept barrel at `src/entries/index.ts`. TS rather than JSON so each entry keeps its verification notes (what was launched, when, how the licence and tool count were determined). Pure data plus a data-free filter; depends only on `@ethosagent/types`. Phase 1 holds the 16 seed `mcp` entries; `MCP_PRESETS` and `MCP_REMOTE_PRESETS` in `@ethosagent/tools-mcp` are derived views over them.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `CATALOG_ENTRIES` | const | Every entry, in barrel order. |
| `getCatalogEntry` | function | Entry by id, or `undefined`. |
| `catalogEntriesOfKind` | function | Entries of one `CatalogKind`. |
| `filterCatalog` | function | `@ethosagent/catalog/filter`: case-insensitive match on id, name, description, publisher, plus kind and tier filters. Imports no entry data. |
| `pinSpec` | function | `name@version` for an npm or PyPI pin. Also exported from `./filter`. |
| `launcherArgs` | function | npx argv (`-y --ignore-scripts spec`) or uvx argv (`spec`) for a pin. Also exported from `./filter`. |

## Seam

Types: `CatalogEntry` and the `CATALOG_*` vocabularies in `packages/types/src/catalog.ts`. Wire schema: `CatalogEntrySchema` in `packages/web-contracts/src/schema/catalog.ts`, pinned equal by `catalog-schema-drift.test.ts`. Archcheck layer: `support`. Plan: `plan/phases/unified-catalog.md` section 4.

## Testing

```
pnpm vitest run packages/catalog
```

Pinning tests:
- `src/__tests__/index.test.ts`: schema parse, unique ids, barrel matches `entries/`, exact pins, `mcp` block iff npm/pypi, no `official` unless publisher is Ethos, no `community` plugin, non-null licence for code.
- `src/__tests__/filter.test.ts`: `filterCatalog`.
- `src/__tests__/pin.test.ts`: `pinSpec` and `launcherArgs`.

## Admission

An entry is admitted by a reviewed PR. Two things guard it: `scripts/check-catalog.ts` re-checks the facts that can rot, and a human fills in the checklist below. The script does not replace the review (a scan is not a review). `.github/CODEOWNERS` routes `src/entries/` to a code owner; branch protection requiring that review is a repository setting, not something this repo enforces.

### Running the script

```
pnpm tsx scripts/check-catalog.ts --changed   # entries touched vs origin/main (main when absent)
pnpm tsx scripts/check-catalog.ts --all       # every entry; what the weekly run does
pnpm vitest run scripts/__tests__/check-catalog.test.ts
```

It prints one block per entry and exits 1 on any failed check (2 on bad usage). CI runs `--changed` on pull requests that touch `packages/catalog/**` and `--all` every Monday, in `.github/workflows/catalog-admission.yml`; a drifted pin fails that run (no issue is opened). The job has no secrets and a read-only token.

| Check | npm | pypi | remote | git |
|---|---|---|---|---|
| Pin resolves | `npm view` `dist.integrity` equals `integrity` | a PyPI file for the version has the pinned sha256 | unauthenticated `initialize` is 200 (auth `none`) or 401 with `WWW-Authenticate` (any other auth) | skipped |
| Code scan | `scanPluginCode` over the packed tarball, red fails | none (D21) | n/a | skipped |
| Advisories | OSV by exact version, HIGH/CRITICAL or an unreachable OSV fails | same, ecosystem `PyPI` | n/a | skipped |
| Declared vs actual | plugin: `ethos.permissions` within `capabilities` (network subset, shell equal) | n/a | url host in `capabilities.network`; no-auth with `toolCount`: `tools/list` count equals it | skipped |
| Licence | registry `license` equals `license` | `license_expression`, `license` or classifier names it | n/a | skipped |

`reviewedAt` older than 365 days is a warning, never a failure. The `git` pin type reports a skip until `withGitPinnedTree` (Phase 3) is wired into the script.

Licences: the registry field must equal the entry's SPDX id. The one exception is a per-id allowance in `LICENSE_FIELD_ALLOWANCES` (`scripts/check-catalog.ts`) for packages that publish `SEE LICENSE IN LICENSE` and ship no LICENSE file (`filesystem`, `memory`). It passes only while the registry still reports exactly that string, and the entry's header comment must record where the SPDX id was read.

### Admission checklist

**Remote** (a hosted service; no code is fetched, `license` is `null`):

- [ ] Who operates the server (the `publisher`, with the domain or org checked).
- [ ] What data it receives: the tool arguments, and the account data the OAuth scopes expose.
- [ ] Its OAuth scopes, and whether DCR issues a public client (the procedure in the header of `extensions/tools-mcp/src/remote-presets.ts`).
- [ ] Its privacy policy URL, linked from the entry's header comment.

**Local** (npm, pypi, git):

- [ ] The exact pin and its digest are in the entry (the script re-derives them).
- [ ] A reviewer has read the code at that pin. The scan is not a review, and Python has no scanner.
- [ ] Filesystem reach (`capabilities.filesystem`) and network reach (`capabilities.network`) match what the code does.
- [ ] Env and credential names (`capabilities.env`) are listed, names only.
- [ ] Lifecycle scripts: none for a plugin; noted in the header comment for an MCP server (the launcher passes `--ignore-scripts`).

A `plugin` entry must be `verified` or `official` (D19): plugins run in-process, and no process isolation exists yet.

### Limitations

- Review is point-in-time. A catalogued entry is not an audited one.
- Declared-vs-actual is checked statically only for plugin permissions and remote hosts. An MCP server's real network reach is not observable without running it in a sandbox, which CI does not do.
- Python entries have no code scanner (D21); the reviewer's read is the only code check.
- OSV matches by package name and version. A package OSV does not know reports zero advisories, which is indistinguishable from a clean one.
- A remote server can change behind the same URL; the weekly run re-checks reachability and tool count, not behaviour.
