# @ethosagent/dashboard

## Purpose

The dashboard subsystem extracted from `apps/web-api`. It owns the SQLite data layer for dashboards and panels, the agent-tool store, panel refresh, param interpolation and validation, and a cron-driven refresh scheduler. Rendering and the RPC surface stay in `apps/web` and `apps/web-api`.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`). 32 names are exported; the main entry points are below.

| Export | Kind | One line |
|---|---|---|
| `DashboardsService` | class | SQLite-backed service for dashboards, panels and params. |
| `DashboardsServiceOptions` | type | Options for `DashboardsService`. |
| `DashboardStore` | class | Store used by the agent-facing dashboard tools. |
| `buildPromptSummary` | function | Condenses a conversation into a prompt a panel can replay. |
| `runPluginQuery` | function | Runs read-only SQL against a plugin data source. |
| `refreshSinglePanel` | function | Refreshes one panel. |
| `refreshPanelById` | function | Refreshes a panel looked up by id. |
| `refreshAllPanels` | function | Refreshes every live panel of a dashboard with its persistent params. |
| `buildRefreshLayers` | function | Groups panels into layers by their `dependsOn` lists. |
| `DashboardRefreshScheduler` | class | Cron-driven sweep that refreshes due dashboards. |
| `assertSelectOnlySql` | function | Throws `INVALID_INPUT` unless the SQL is a single SELECT. |
| `interpolateParams` | function | Substitutes `{key}` and `{{key}}` placeholders from ephemeral, persistent and default params. |
| `validateParamValue` | function | Checks one param value against its `ParamDef`. |
| `findInvalidParamKeys` | function | Lists param values not permitted by a schema. |
| `parseImportPayload` | function | Validates an imported dashboard against `DashboardImportPayloadSchema`. |

## Seam

Depends on `@ethosagent/types` (`SessionStore`, `Logger`, `EthosError`, `WidgetTemplate`) and opens its database through `@ethosagent/sqlite`. Archcheck layer: `extensions`. The dashboard database is not on the `synchronous` roster in `.claude/rules/sqlite-durability.md`, so it stays at SQLite's default.

Pinned in `src/__tests__/interpolate-params.test.ts`: `assertSelectOnlySql` rejects a non-SELECT statement and stacked statements. `DashboardsService` uses the same guard on `addPanel`, `updatePanel` and import (comment on the function in `src/interpolate-params.ts`).

## Testing

```
pnpm vitest run extensions/dashboard
```

Pinning tests in `src/__tests__/`: `src/__tests__/dashboards.service.test.ts` (service CRUD and `busy_timeout`), `src/__tests__/dashboard-store.test.ts` (agent-tool store), `src/__tests__/interpolate-params.test.ts` (param validation, SELECT-only guard, import payload), `src/__tests__/refresh-scheduler.test.ts` (scheduler stop), `src/__tests__/dashboard-refresh-answer.test.ts` (a refreshed panel gets the whole answer), `src/__tests__/dashboard-refresh-error.test.ts` (errored turn handling).
