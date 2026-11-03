# @ethosagent/tools-search-console

## Purpose

Read-only Google Search Console tools: `gsc_sites` lists properties and `gsc_queries` returns search analytics. Auth is one service-account key held as a named secret, exchanged for a short-lived token; requests are limited to the Search Console and Google token hosts.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths). Main entry points.

| Export | Kind | One line |
|---|---|---|
| `createGscSitesTool` | function | Builds `gsc_sites`. |
| `createGscQueriesTool` | function | Builds `gsc_queries`. |
| `GscQueriesArgs` | interface | Query input. |
| `resolveRange` | function | Resolves the date window and defaults. |
| `parseServiceAccountJson` | function | Parses a service-account key into a `ServiceAccount`. |
| `getAccessToken` | function | Cached token for a key. |
| `mintAccessToken` | function | Signs an assertion and exchanges it for a token. |
| `describeGscApiError` | function | Maps API failures to actionable tool errors. |
| `selectGscSecretRef` | function | Picks the secret ref from tool settings. |
| `ALLOWED_HOSTS` | const | Hosts the tools may call. |
| `SCOPE` | const | OAuth scope (webmasters.readonly). |

## Seam

Implements `Tool` from `@ethosagent/types`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-search-console
```

Pinning tests in `src/__tests__/`: `src/__tests__/queries.test.ts` (default 28-day window, refuses a start date outside the 16-month window or an end before the start before any network call), `src/__tests__/auth.test.ts` (key parsing, token minting), `src/__tests__/errors.test.ts` (403 reason mapping), `src/__tests__/sites.test.ts` (roster rendering, a throwing secrets backend answers with the no-key message and not the raw ref).
