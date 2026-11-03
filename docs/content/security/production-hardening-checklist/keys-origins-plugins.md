---
title: "Production hardening: API keys, origins and plugin data sources"
description: "Steps 10-13: backups, API keys, admin panel, CORS origins, plugin SQL."
kind: how-to
audience: shared
time: "10 min"
updated: 2026-11-03
---

## Task

Document backup and token rotation, scope API keys, keep the admin panel off, enumerate browser origins and review plugin data source permissions.

## Result

Every step on this page is applied and the checks in [Verify](../production-hardening-checklist.md#verify) on the main page pass.

## Prereqs

Complete the [Prerequisites](../production-hardening-checklist.md#prerequisites) listed on the main page, [Production hardening checklist](../production-hardening-checklist.md).

## Steps

### 10. Document backup and token rotation

Production credentials rotate. Document:

- **Which tokens** are in use (platform, scope, last rotated).
- **Where they are stored** (secrets provider, ARN, env var name).
- **How to rotate** without downtime (mint new token, update the secret, restart the gateway, revoke the old token).
- **Rotation cadence** -- at minimum every 90 days for platform tokens, immediately if a leak is suspected.

For a step-by-step rotation procedure, see [Bot token rotation playbook](.././bot-token-rotation-playbook.md).

**Verify:** Perform a dry-run rotation of one non-critical token. Confirm the gateway reconnects with the new token and the old token is revoked.

### 11. Scope API keys and keep the admin panel off

The web API always requires a credential on `/rpc/*`: the `ethos_auth` cookie (a login session on a claimed instance, or the web token on an unclaimed one), or a bearer API key. There is nothing to switch on. Harden what is already there:

- Set `ETHOS_WEB_TOKEN` from your secret manager instead of letting `ethos serve` generate a token file. The value must be at least 24 characters — a shorter one stops the boot with an error suggesting `openssl rand -hex 32` — and while the variable is set, the sign-in URL is never printed to logs.
- Claim the instance: open `/welcome`, enter the bootstrap token, and set a username and password. After claiming, a token in a URL no longer signs a browser in — the printed URL only prefills the reset form at `/welcome/reset` — while machine clients keep minting the token cookie unchanged.
- Record the recovery path in your runbook: `/welcome/reset`, gated by the bootstrap token. The login screen has no reset link, and a successful reset signs out every browser session.
- If you do not use the admin panel, leave `admin.enabled` unset. Admin procedures then refuse every caller with `403`.
- Mint each API key with the narrowest scope it needs: `ethos api-key create --name <label> --scopes sessions:read`.
- Revoke keys nobody uses. List them with `ethos api-key list`, then run `ethos api-key revoke <prefix>`.

**Verify:**

```bash
# No credential — should return 401
curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' \
  -d '{"json":{}}' http://localhost:3000/rpc/sessions/list
# 401

# API key with sessions:read — should return 200
curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ETHOS_API_KEY" \
  -d '{"json":{}}' http://localhost:3000/rpc/sessions/list
# 200

# The same key against the admin namespace — should return 403
curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ETHOS_API_KEY" \
  -d '{"json":{}}' http://localhost:3000/rpc/admin/getStatus
# 403
```

See [Security controls -- web dashboard and admin authentication](.././controls.md#admin-panel-token-auth).

### 12. Enumerate the browser origins allowed to call the web API

There is no `cors` block in `config.yaml`. Two separate lists control which browser origins may reach the web API.

| Setting | Format | Governs | Enforced by |
|---|---|---|---|
| `ETHOS_ALLOWED_ORIGINS` (env var only) | Comma-separated. Exact origins, or `*.domain` wildcards that also match the bare domain. A wildcard on a shared hosting domain such as `*.fly.dev` stops `ethos serve` at startup | Credentialed CORS on every web API route except `/v1/*`, which reflects exact entries only. The CSRF check on `/rpc/*` and `/openapi/*`, which accepts wildcards and, once set, refuses every origin not listed. The WebSocket origin check, which accepts exact entries only | `resolveAllowedOrigins` in `apps/ethos/src/commands/serve-helpers.ts`; `resolveCorsOrigin` in `apps/web-api/src/routes/index.ts`; `csrfMiddleware` in `apps/web-api/src/middleware/csrf.ts`; `originAllowed` in `apps/web-api/src/voice/voice-socket.ts` |
| `ETHOS_API_CORS_ORIGINS` env var, else `web.corsOrigins` in `config.yaml` | Comma-separated exact origins, or `*`. Not credentialed | CORS on `/v1/*`, preflights included. `ETHOS_ALLOWED_ORIGINS` does not apply there | `resolveCorsOrigins` in `apps/ethos/src/commands/serve-helpers.ts`; `openAiCors` in `apps/web-api/src/middleware/openai-cors.ts` |

Neither list is needed for the Mission Control desktop app in remote mode: it loads the remote server's own SPA same-origin (see [desktop remote connection security](.././controls.md#desktop-remote-connection)). A browser dashboard served from another origin, such as the one in [Deploy Mission Control with a remote Ethos](../../building/how-to/deploy-mission-control-remote.md), needs its exact origin in `ETHOS_ALLOWED_ORIGINS`.

- Do not list `*` in `ETHOS_ALLOWED_ORIGINS`. It is not a wildcard there, so it matches nothing.
- If you also use the server's own web UI, list the server's own origin too. Once the variable is set, the CSRF check refuses cookie requests from any origin not listed, the server's own included.
- If a browser app calls `/v1/*` directly, list its origin in `ETHOS_API_CORS_ORIGINS` (or `web.corsOrigins`). Listing it in `ETHOS_ALLOWED_ORIGINS` does nothing for `/v1/*`.

```bash
# ethos serve environment
export ETHOS_ALLOWED_ORIGINS="https://dashboard.example.com,https://ethos.example.com"
```

**Verify:**

```bash
# Listed origin — the preflight reflects it
curl -s -o /dev/null -D - -X OPTIONS \
  -H 'Origin: https://dashboard.example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  http://localhost:3000/rpc/sessions/list | grep -i access-control-allow-origin
# access-control-allow-origin: https://dashboard.example.com

# Any other origin — no access-control-allow-origin header
curl -s -o /dev/null -D - -X OPTIONS \
  -H 'Origin: https://other.example.net' \
  -H 'Access-Control-Request-Method: POST' \
  http://localhost:3000/rpc/sessions/list | grep -i access-control-allow-origin
# (no output)
```

- Pinned by: `apps/ethos/src/commands/__tests__/serve-helpers.test.ts` (both resolvers, including the shared-domain refusal), `apps/web-api/src/__tests__/routes/cors-origin.test.ts` (`resolveCorsOrigin`), `apps/web-api/src/__tests__/middleware/csrf.test.ts`, `apps/web-api/src/__tests__/middleware/openai-cors.test.ts`, `apps/web-api/src/__tests__/routes/v1-cors-preflight.test.ts` (the full app: `/v1/*` preflights answer from the `/v1` list only, and `/rpc/*` preflights are unchanged)

### 13. Review plugin data source permissions

Confirm every plugin data source is registered as read-only. The dashboard query executor enforces read-only transactions, but review that no plugin bypasses the `registerDataSource` path with direct database access.

**Verify:**

```bash
# Attempt a write query via the dashboard — should be rejected
curl -s -X POST -H "Authorization: Bearer $ETHOS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "DROP TABLE test"}' \
  http://localhost:3000/api/data-sources/my-plugin/query
# Should return an error indicating write operations are not allowed
```

See [Security controls -- read-only plugin data source access](.././controls.md#read-only-sql) and [Register a plugin data source](../../building/how-to/register-plugin-data-source.md).

## Verify

Run the [Verify](../production-hardening-checklist.md#verify) steps on the main page once all parts are done.

## Troubleshoot

See [Troubleshooting](../production-hardening-checklist.md#troubleshooting) on the main page.
