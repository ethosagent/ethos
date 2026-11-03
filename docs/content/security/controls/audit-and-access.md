---
title: "Security controls: audit, admin auth and remote access"
description: "Audit substrate, cron containment, admin auth, read-only SQL, desktop remote."
kind: reference
audience: shared
updated: 2026-11-03
---

## Synopsis {#synopsis}

The audit substrate, cron output containment, admin panel auth, read-only plugin SQL, desktop remote connection security and removed safety stubs. Part of the [Security controls](../controls.md).

## Audit substrate — observability.db {#audit-substrate}

*Status: Shipped (write path and the categories marked emitted). Not shipped (`audit.transition`, `audit.redacted`, policy snapshots).*

Safety events land in `observability.db` as typed events. `EventCategory` is a string (`packages/types/src/observability.ts`); the Ethos vocabulary is `ETHOS_EVENT_CATEGORIES` in `packages/wiring/src/observability/ethos-observability.ts`.

| Category | Emitted today? | What it records |
|---|---|---|
| `audit.approval` | Yes | Operator approved or denied a tool call, with sender attribution (`recordSafetyApproval`) |
| `audit.block` | Yes | Any safety refusal. The `code` field says which: `tool_blocked` (hook refusal, including hardline), `tool_downgraded_post_untrusted_read`, `injection_detected`, `injection_classifier_failed`, `channel.allowlist.blocked`, `channel.mention_gate`, and others |
| `audit.watcher` | Yes | Watcher paused or terminated a turn (`recordWatcherDecision`) |
| `audit.injection_flag` | Yes, gateway only | Tier 1 matched an inbound channel message (code `channel.injection_detected`) or a background-job summary. Flags on tool results are `audit.block` / `injection_detected` instead |
| `channel.pairing` | Yes, gateway only | Pairing code issued; `/allow` failed (`Gateway.recordPairing`) |
| `channel.allow` / `channel.deny` | Yes, gateway only | Owner approved a pairing code / ran `/deny` |
| `install.scan` | Yes, on the CLI install paths and learning promotion | Skill or plugin scan decision (`installScanEvent`); see [Static-analysis pattern scanner](install.md#static-analysis-pattern-scanner) for the paths not covered |
| `install.event` | Yes | Agent-mesh journal entries and `ethos data reset` |
| `audit.transition` | **No** | `recordSafetyTransition` exists; nothing calls it. `ethos audit` and the support bundle filter on it and find nothing |
| `audit.redacted` | **No** | `recordRedacted` exists; nothing calls it |

The store uses STRICT-mode SQLite tables in WAL mode with `synchronous = NORMAL` (see the durability table in `CLAUDE.md`). It has no FTS5 index. Retention is set per **domain prefix**, not per category, with `retention.events.<domain>` lines in `~/.ethos/config.yaml`, and a per-personality override with `personalities.<id>.retention.events.<domain>` lines in the same file:

| Prefix | Default retention |
|---|---|
| `error` | 90 days |
| `audit.*` | 365 days |
| `channel.*` | 365 days |
| `install.*` | Forever |

Policy snapshots are **not written today**. The snapshot table and `recordSnapshot` exist in `extensions/observability-sqlite/src/service.ts`, but nothing calls `recordSnapshot` and `startTurnTrace` is never given a `snapshotId`. You cannot yet reconstruct a personality's network policy at the time of an event from the store.

- Source: `extensions/observability-sqlite/src/store.ts`, `extensions/observability-sqlite/src/service.ts`, `extensions/observability-sqlite/src/retention.ts`

## Cron output path containment {#cron-output-path-containment}

*Status: Shipped (lexical containment). Not covered (symlinks).*

`CronScheduler.readRunOutput()` and `readRunProgress()` read only paths inside the scheduler's `outputDir`. `assertInOutputDir` resolves the path and refuses it when the path relative to `outputDir` starts with `..` or is absolute. A path that contains `..` but resolves inside `outputDir` is allowed. The check is lexical: it does not walk symlinks, so a link inside `outputDir` that points elsewhere is followed.

- Source: `assertInOutputDir` in `extensions/cron/src/index.ts`
- Tests: `extensions/cron/src/__tests__/cron.test.ts`, `extensions/cron/src/__tests__/run-progress.test.ts`

## Web dashboard and admin authentication {#admin-panel-token-auth}

*Status: Shipped.*

The web API accepts two credentials. There is no `ethos token create` command and no OS-keychain token store on the server.

| Credential | How it is issued | Where it is accepted | Enforced by |
|---|---|---|---|
| `ethos_auth` cookie | Unclaimed instance: `ethos serve` prints a `?t=<token>` URL; `GET /auth/exchange` (or a token pasted into `POST /auth/token-login`) sets the cookie (`HttpOnly`, `SameSite=Strict`). Claimed instance: `POST /auth/login` (username + password, argon2id hash in `<dataDir>/web-admin.json`) issues a server-side session id. Machine clients mint the cookie from `<dataDir>/web-token` directly; one shared verifier accepts a session id or the raw token | `/rpc/*`, `/sse/*`, `/openapi/*`, `/setup/whatsapp/*`, and the voice, satellite and takeover WebSockets | `authRoutes` in `apps/web-api/src/routes/auth.ts`; `authMiddleware` in `apps/web-api/src/middleware/auth.ts`; `dualAuth` in `apps/web-api/src/middleware/dual-auth.ts` |
| Bearer API key (`sk-ethos-…`) | `ethos api-key create --name <label> [--scopes <a,b>]` (default scope `chat`), or the web Settings page through the `apiKeys.create` RPC. Stored hashed in `sessions.db` by `SqliteApiKeyStore` (`extensions/session-sqlite/src/api-key-store.ts`) | `/rpc/*` and `/sse/*` methods whose namespace maps to the key's scope in `SCOPE_MAP`, plus the OpenAI-compatible `/v1/*` surface (scope `chat`), `/metrics` (`metrics:read`) and `/cron/fire` (`cron`) | `dualAuth` and `resolveScope` in `apps/web-api/src/middleware/dual-auth.ts`; `bearerAuth` in `apps/web-api/src/middleware/bearer-auth.ts` |

Claiming is opt-in. An instance with no `web-admin.json` is unclaimed and stays in token mode indefinitely. Claiming it at `/welcome` (bootstrap token + username + password) is what retires browser token login: from then on the exchange URL redirects to `/welcome/reset` with the token prefilled and grants no session, while the raw token stays cookie-valid for machine clients. `ETHOS_WEB_TOKEN` in the environment replaces the generated token file — at least 24 characters, checked at boot — and suppresses the printed URL. Reset lives at `/welcome/reset`, gated by the bootstrap token; the login screen carries no reset link, and a successful reset invalidates all human sessions. All the `/auth` POSTs are rate-limited and Origin-checked.

A request with neither credential receives `401 Unauthorized`. A bearer key is refused with `403 Forbidden` in these cases:

- **Unmapped namespaces.** Any namespace absent from `SCOPE_MAP`, which includes `admin` and `outbox`, is cookie-only. `dualAuth` fails closed on it.
- **Cookie-only methods.** Methods mapped to `COOKIE_ONLY`, such as `personalities.create` and `tools.test`, reject every bearer key.
- **The `apiKeys` namespace.** A bearer key cannot mint or revoke keys. `cookieOnlyGuard` refuses it at the route, and `dualAuth` refuses it again.
- **Missing scope.** A key without the method's required scope is refused.

The `admin` namespace has a second gate. Every admin procedure calls `requireAdmin` (`apps/web-api/src/services/admin.service.ts`), which returns `403` unless `admin.enabled: true` is set in `~/.ethos/config.yaml`. The default is disabled.

When `ethos serve` is not given an API-key store, `/rpc/*` and `/sse/*` fall back to `authMiddleware`, which accepts the cookie only (`apps/web-api/src/routes/index.ts`).

- Pinned by: `apps/web-api/src/__tests__/routes/auth-and-rpc.test.ts` (cookie exchange, `401` without a cookie), `apps/web-api/src/__tests__/middleware/dual-auth-scope.test.ts` (fail-closed and cookie-only methods), `apps/web-api/src/__tests__/middleware/apikeys-auth-bypass.test.ts` (`apiKeys` namespace), `apps/web-api/src/__tests__/routes/admin.test.ts` (`admin.enabled` gate)
- Limitation: no test sends a bearer key to an `admin` procedure. The refusal comes from the generic unmapped-namespace branch in `dualAuth`, which `dual-auth-scope.test.ts` exercises through `outbox`.
- Cross-ref: [Authenticate your dashboard users](../../building/how-to/authenticate-dashboard-users.md)

## Read-only plugin data source access {#read-only-sql}

*Status: Shipped.*

Plugin data sources expose SQLite databases to the dashboard. Read-only enforcement lives at the SQLite connection, not in a keyword filter: both query paths open the database with `new Database(dbPath, { readonly: true })`, so the engine refuses every write regardless of what the statement text says.

Connection-level read-only is the stronger property. A denylist of write keywords is a guess about what a string means, and SQL offers cheap ways to make a write not look like one — a leading comment, unexpected casing, a `WITH` prefix, or a keyword that never appears at the position the filter inspects. A connection opened read-only does not interpret intent; SQLite refuses the write at execution.

| Layer | Where | What it does |
|---|---|---|
| Read-only connection | `runPluginQuery` in `dashboards.service.ts`; `refreshSinglePanel` in `dashboard-refresh.ts` | Engine-level refusal of all writes. Covers both query paths. |
| SELECT-only statement guard | `assertSelectOnlySql` in `interpolate-params.ts` | Write-time. Requires a single statement beginning with `SELECT`, and rejects embedded `;`. `addPanel` applies it to every SQL panel, and `updatePanel` applies it whenever a patch sets `sqlQuery`. |
| Param allowlist | `findInvalidParamKeys` in `interpolate-params.ts` | Values interpolated into panel SQL must match a declared `select`/`options` option or a `YYYY-MM-DD` date. Template positions cannot be `?`-bound, so this allowlist is the injection defense on that path. |
| Keyword prefix denylist | `MUTATING` in `runPluginQuery` | Ad-hoc `dashboards.runQuery` RPC only. Rejects eight leading keywords. It tests only the statement's first word — a usability guard, not a boundary. |

Both paths that read a plugin data source carry the read-only connection: `runPluginQuery`, behind the ad-hoc `dashboards.runQuery` RPC, and `refreshSinglePanel`, behind scheduled and manual panel refresh. There is no third path — `getDataSourcePath` in `extensions/plugin-loader/src/index.ts` has exactly these two callers.

Registration itself is not validated. `registerDataSource(id, path)` (`PluginApiImpl` in `packages/plugin-sdk/src/index.ts`) records whatever identifier and filesystem path the plugin passes, with no path containment, extension check, or identifier constraint. A plugin can therefore point a data source at any SQLite file the host process can open. That is consistent with the plugin trust model — plugin code already runs in-process — but it means the boundary here is read-only access, not restricted reach.

- Source: `extensions/dashboard/src/dashboards.service.ts`, `extensions/dashboard/src/dashboard-refresh.ts`, `extensions/dashboard/src/interpolate-params.ts`
- Cross-ref: [Register a plugin data source](../../building/how-to/register-plugin-data-source.md)

## Desktop remote connection security {#desktop-remote-connection}

*Status: Shipped.*

When Mission Control connects to a remote Ethos instance, the web token is encrypted with Electron `safeStorage` (whose key the OS keychain holds) and stored in the app's `keychain.json`, not in plaintext config (`apps/desktop/src/main/keychain.ts`). The main process writes it onto the remote origin as the `ethos_auth` cookie before navigating; the window then loads the remote server's own SPA same-origin, so there is no cross-origin request to authorize. `/auth/exchange` is deliberately not used — the app already holds the token, and the token stays cookie-valid whether or not the instance is claimed, so the desktop flow is unchanged by web claiming.

The renderer never receives the token itself. The `keychain:preview` IPC returns a masked preview — the first 3 and last 4 characters — for display (`maskApiKey` in `apps/desktop/src/main/ipc.ts`).

- Source: `apps/desktop/src/main/connection.ts`, `apps/desktop/src/main/keychain.ts`
- Cross-ref: [Deploy Mission Control with a remote Ethos](../../building/how-to/deploy-mission-control-remote.md)

## Removed empty safety stubs {#removed-empty-safety-stubs}

Five directories under `extensions/` carried safety-package names and shipped no code: `safety-injection/` and `safety-scanner/`, removed earlier, and `safety-channel/`, `safety-network/`, and `safety-watcher/`, removed in this release. All five are gone. The real implementations live under `packages/safety/` — `injection/`, `scanner/`, `channel/`, `network/`, `watcher/`, `redact/`, and `groundtruth/` — which are the source paths listed throughout this page and the Tier 0 members named in [the security boundary](.././security-boundary.md#tiers).

Empty directories with kernel names in the extensions tree are not cosmetic. They point a reader looking for the kernel at the wrong tier, which is the one thing the tier roster exists to prevent.

## See also {#see-also}

- [Security controls](../controls.md) — the index page for this reference.
