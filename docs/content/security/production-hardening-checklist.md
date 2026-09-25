---
title: Production hardening checklist
description: Step-by-step checklist for hardening an Ethos deployment before production — secrets, tokens, network, filesystem, observability, and container settings.
kind: how-to
audience: shared
slug: production-hardening-checklist
time: "30 min"
updated: 2026-09-25
---

## Task

Harden an Ethos deployment so every security control documented in [Security controls](./controls.md) is active and verified before the first production message reaches the agent.

## Result

After completing this checklist you will have: secrets out of plaintext config, platform tokens scoped to least privilege, filesystem and network boundaries declared per personality, channel filtering active, injection defenses confirmed, observability writing and redacting, and (if containerised) a locked-down runtime.

## Prerequisites

- A working Ethos installation (`ethos` CLI responds to `ethos --version`).
- At least one personality configured under `~/.ethos/personalities/<id>/`.
- Access to the platform tokens you plan to use (Slack, Telegram, Discord, GitHub, Linear).
- Familiarity with the [threat model](./threat-model.md) and which threats are in scope for your deployment.

## Steps

### 1. Move secrets out of plaintext config

Replace every literal credential in `~/.ethos/config.yaml` with a `${secrets:ref}` substitution. Ethos resolves these at startup through the configured secrets provider.

Available providers:

| Provider | When to use |
|---|---|
| `FileSecretsResolver` | Single-machine deployments. Reads from a JSON file outside `~/.ethos/` (e.g. `/etc/ethos/secrets.json`) with restrictive file permissions. |
| `EnvSecretsResolver` | Container deployments where secrets are injected as environment variables by the orchestrator. |
| AWS Secrets Manager | Production cloud deployments. Configure the resolver with the secret ARN; values are fetched at startup and cached for the process lifetime. |

**Verify:**

```bash
# Confirm no plaintext secrets remain in config
grep -rn 'sk-ant-\|sk-\|xoxb-\|AKIA' ~/.ethos/config.yaml
# Should return no matches

# Confirm secrets resolve at startup
ethos secrets list
# Should show each ref and its resolution status (resolved / missing)
```

### 2. Scope platform tokens to minimum privilege

Each platform token (Slack, Telegram, Discord, GitHub, Linear) should be minted with the narrowest scopes the agent actually needs. Over-scoped tokens widen the blast radius if a token leaks.

- Slack: `chat:write`, `channels:read`, `users:read` -- not `admin.*`.
- Telegram: BotFather token with no payment or group-admin permissions.
- Discord: bot scope only; no `Administrator` intent.
- GitHub: fine-grained PAT scoped to specific repos, read-only where possible.
- Linear: API key scoped to the workspace; no organisation-admin access.

For per-platform scope tables and rotation instructions, see [Least-privilege tokens](./least-privilege-tokens.md).

**Verify:** Review each token's granted scopes in the platform's developer console. Confirm no token has admin-level access.

### 3. Declare filesystem reach per personality

Every personality must declare `fs_reach` in its `config.yaml` with explicit read and write paths. The global deny floor (`.ssh`, `.aws`, `/etc/shadow`, and the rest of the always-deny set) is enforced by `ScopedStorage` regardless of what `fs_reach` allows -- see [Security controls -- ScopedStorage](./controls.md#scoped-storage-and-boundary-error).

```yaml
# ~/.ethos/personalities/engineer/config.yaml
fs_reach:
  read:
    - ~/projects/myapp
  write:
    - ~/projects/myapp/src
```

A personality with no `fs_reach` declaration gets no filesystem access beyond its own personality directory.

**Verify:**

```bash
ethos personality show <id>
# Check the "Filesystem reach" section.
# Confirm read/write paths match what this personality needs — nothing more.
```

### 4. Declare network policy per personality

Personalities with web tools (`web_extract`, the browser tools) should declare `safety.network.allow` in their `config.yaml`. Without it, a tool that declares `allowedHosts: ['*']` — `web_extract` among them — reaches no host at all, and a tool that names its own hosts reaches exactly those. The list takes hosts only: an exact host or a leading `*.` pattern, no ports. A bare `*` does not mean "any host"; `safeFetch` refuses every host under it. The global SSRF, scheme-allowlist, and cloud-metadata controls apply to all personalities either way. See [Security controls -- network](./controls.md#per-personality-network-policy).

```yaml
# In the personality's config.yaml
safety:
  network:
    allow:
      - api.github.com
      - "*.slack.com"
```

**Verify:**

```bash
grep -A6 'network:' ~/.ethos/personalities/<id>/config.yaml
# Confirm only the hosts this personality needs are listed.
```

### 5. Configure channel security

Set up `channel_filter` in `~/.ethos/config.yaml` for every active channel adapter:

- **Sender allowlist:** restrict which user IDs can reach the agent. Unknown senders are dropped before the message enters the agent loop.
- **DM pairing codes:** with `dmPolicy: pairing` (the default), an unknown sender who DMs the bot gets a one-time code, and only the owner can redeem it with `/allow <code>`. Codes are random, bound to the sender they were issued for, single-use, and expire after an hour.
- **Context visibility:** set `contextVisibility: allowlist` to strip quoted replies to non-allowlisted senders and their lines of channel history. `allowlist_quote` is an alias with the same behaviour. Avoid the default `all` in production unless the channel is fully trusted.

See [Security controls -- channel](./controls.md#channel-level-controls) for the full set of channel-layer controls.

```yaml
channel_filter.telegram.ownerUserId: 123456789
channel_filter.telegram.recipientAllowlist: 234567890,345678901
channel_filter.telegram.dmPolicy: pairing
channel_filter.telegram.contextVisibility: allowlist
channel_filter.slack.ownerUserId: U01ABC123
channel_filter.slack.contextVisibility: allowlist
```

**Verify:** Send a message from a non-allowlisted account. Confirm it is dropped (a DM gets a pairing code instead of an answer) and that an `audit.block` event with code `channel.allowlist.blocked` (DM) or `channel.mention_gate` (group) appears in `observability.db`.

### 6. Confirm injection defenses are active

The `INJECTION_DEFENSE_PRELUDE` system prompt is always-on -- it is injected into every personality's prompt automatically. No action is needed to enable it.

Confirm that `wrapUntrusted` covers all untrusted input surfaces:

- **Channel messages:** the gateway wraps every admitted inbound message, and any channel history attached to it, with provenance markers.
- **Tool results:** a result is wrapped only when its tool declares `outputIsUntrusted: true` — `web_extract`, `read_file`, `search_files`, `terminal`, the browser page-reading tools and MCP tools among them. A tool that does not declare it is not wrapped, and its results do not arm the post-read downgrade.

The only case where action is required: if you have written **custom tools** that return external content, set `outputIsUntrusted: true` on each of them. The agent loop then wraps the result, runs the pattern check, and arms the post-read downgrade (`handleUntrustedResult` in `packages/core/src/agent-loop/result-defense.ts`).

**Verify:** No explicit verification step unless you have custom tools. If you do, confirm each custom tool that returns external content declares `outputIsUntrusted: true`.

### 7. Set up observability and retention

Confirm the audit substrate is writing:

```bash
# Check that observability.db exists and is receiving events
ls -la ~/.ethos/observability.db
sqlite3 ~/.ethos/observability.db "SELECT category, COUNT(*) FROM events GROUP BY category;"
```

Confirm credential redaction is active. Redaction is always-on at the observability store layer -- `redactString` and `redactJson` fire before any value reaches disk. The per-personality `safety.observability` knob controls storage granularity:

| Mode | What is stored |
|---|---|
| `none` | Events only (no tool args, no tool bodies, no LLM payloads) |
| `redacted` | Tool args and bodies stored after pattern-based redaction |
| `full` | Everything stored (use only in development) |

Set retention policies per audit category. Production deployments should retain `audit.*` and `channel.*` events for at least 90 days.

```yaml
# In config.yaml
observability:
  retention:
    "audit.*": "90d"
    "channel.*": "90d"
    "install.*": "30d"
```

**Verify:**

```bash
# Confirm redaction is working — inject a test key pattern and check the log
sqlite3 ~/.ethos/observability.db \
  "SELECT data FROM events ORDER BY rowid DESC LIMIT 5;"
# No raw API keys (sk-ant-*, AKIA*, xoxb-*) should appear in the output.
```

### 8. Harden the container (Docker deployments)

If running Ethos in Docker, apply these constraints:

| Setting | Value | Why |
|---|---|---|
| User | Non-root (`USER 1000:1000`) | Limits blast radius of any escape |
| Root filesystem | Read-only (`--read-only`) | Prevents runtime binary replacement |
| Inbound ports | None, unless the web API is exposed | Reduces attack surface |
| Healthcheck | `HEALTHCHECK CMD ethos health` | Orchestrator can restart a stuck process |
| Volume for `~/.ethos/` | EBS-backed (or equivalent persistent volume) | Survives container restarts; WAL needs a real filesystem |
| Tmpfs | Mount `/tmp` as tmpfs | Scratch space without persisting to the volume |

Example `docker run`:

```bash
docker run \
  --user 1000:1000 \
  --read-only \
  --tmpfs /tmp \
  -v /data/ethos:/home/ethos/.ethos \
  --health-cmd="ethos health" \
  --health-interval=30s \
  ethos:latest
```

**Verify:**

```bash
# Inside the container
whoami          # Should NOT be root
touch /bin/test # Should fail (read-only root FS)
```

### 9. Validate bot bindings (multi-bot deployments)

In multi-bot deployments the gateway holds a `Map<botKey, AgentLoop>` -- one loop per configured bot. Each bot binding must point to an existing personality and team.

- Confirm every `botKey` in the config maps to a personality directory under `~/.ethos/personalities/`.
- Confirm each bot's `platform` and `token` pair is correct.
- Confirm `botKey` values are stable across restarts (use the `id:` field in config, or accept the sha256-derived default).

Run the config strict loader to catch dangling references:

```bash
ethos config validate --strict
# Should exit 0 with no warnings about missing personalities or teams.
```

**Verify:** Restart the gateway. Confirm all bots connect and the observability log shows a startup event for each `botKey`.

### 10. Document backup and token rotation

Production credentials rotate. Document:

- **Which tokens** are in use (platform, scope, last rotated).
- **Where they are stored** (secrets provider, ARN, env var name).
- **How to rotate** without downtime (mint new token, update the secret, restart the gateway, revoke the old token).
- **Rotation cadence** -- at minimum every 90 days for platform tokens, immediately if a leak is suspected.

For a step-by-step rotation procedure, see [Bot token rotation playbook](./bot-token-rotation-playbook.md).

**Verify:** Perform a dry-run rotation of one non-critical token. Confirm the gateway reconnects with the new token and the old token is revoked.

### 11. Scope API keys and keep the admin panel off

The web API always requires a credential on `/rpc/*`: the `ethos_auth` cookie from the sign-in URL `ethos serve` prints, or a bearer API key. There is nothing to switch on. Harden what is already there:

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

See [Security controls -- web dashboard and admin authentication](./controls.md#admin-panel-token-auth).

### 12. Enumerate the browser origins allowed to call the web API

There is no `cors` block in `config.yaml`. Two separate lists control which browser origins may reach the web API.

| Setting | Format | Governs | Enforced by |
|---|---|---|---|
| `ETHOS_ALLOWED_ORIGINS` (env var only) | Comma-separated. Exact origins, or `*.domain` wildcards that also match the bare domain. A wildcard on a shared hosting domain such as `*.fly.dev` stops `ethos serve` at startup | Credentialed CORS on every web API route except `/v1/*`, which reflects exact entries only. The CSRF check on `/rpc/*` and `/openapi/*`, which accepts wildcards and, once set, refuses every origin not listed. The WebSocket origin check, which accepts exact entries only | `resolveAllowedOrigins` in `apps/ethos/src/commands/serve-helpers.ts`; `resolveCorsOrigin` in `apps/web-api/src/routes/index.ts`; `csrfMiddleware` in `apps/web-api/src/middleware/csrf.ts`; `originAllowed` in `apps/web-api/src/voice/voice-socket.ts` |
| `ETHOS_API_CORS_ORIGINS` env var, else `web.corsOrigins` in `config.yaml` | Comma-separated exact origins, or `*`. Not credentialed | CORS on `/v1/*`, preflights included. `ETHOS_ALLOWED_ORIGINS` does not apply there | `resolveCorsOrigins` in `apps/ethos/src/commands/serve-helpers.ts`; `openAiCors` in `apps/web-api/src/middleware/openai-cors.ts` |

Neither list is needed for the Mission Control desktop app in remote mode: it loads the remote server's own SPA same-origin (see [desktop remote connection security](./controls.md#desktop-remote-connection)). A browser dashboard served from another origin, such as the one in [Deploy Mission Control with a remote Ethos](../building/how-to/deploy-mission-control-remote.md), needs its exact origin in `ETHOS_ALLOWED_ORIGINS`.

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

See [Security controls -- read-only plugin data source access](./controls.md#read-only-sql) and [Register a plugin data source](../building/how-to/register-plugin-data-source.md).

## Verify

Run the config strict loader to confirm no warnings remain:

```bash
ethos config validate --strict
```

Then run a quick end-to-end smoke test: send a message from a non-allowlisted account and confirm it is dropped. Send a message from an allowlisted account and confirm `observability.db` records the expected `channel.allow`, `audit.tool_call`, and redaction events. Check that no plaintext secrets appear in the audit output:

```bash
sqlite3 ~/.ethos/observability.db \
  "SELECT category, COUNT(*) FROM events GROUP BY category;"
```

If every step above passes, the deployment is hardened.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ethos secrets list` shows `missing` for a ref | Secret not found in the configured provider | Add the secret to the provider (file, env, or Secrets Manager) |
| `BoundaryError` on a path the personality should reach | `fs_reach` too narrow or symlink resolving outside the allowlist | Widen `fs_reach` to include the resolved real path |
| Agent responds to unknown senders | `channel_filter` not configured or `allowedSenders` empty | Add sender IDs to the allowlist; enable pairing |
| `observability.db` is empty | Database path misconfigured or the process lacks write permission | Check `observability.db` path in config; confirm the process user can write to it |
| Container crashes on startup with read-only FS | `~/.ethos/` not mounted as a writable volume | Mount a persistent volume at the `~/.ethos/` path |
| `ethos config validate --strict` reports missing personality | Bot binding references a personality ID that does not exist | Create the personality directory or fix the `botKey` mapping |
| Web UI returns `401` for every request | No `ethos_auth` cookie, or the cookie no longer matches the stored token | Open the sign-in URL `ethos serve` prints (`?t=<token>`) again |
| Admin panel returns `403` | `admin.enabled: true` is not set, or the request used an API key | Set `admin.enabled: true` in `config.yaml` and use the web UI; API keys cannot reach admin procedures |
| CORS error in a browser dashboard served from another origin | Its origin is not in `ETHOS_ALLOWED_ORIGINS` (a `*.domain` wildcard does not count for CORS) | Add the exact origin to `ETHOS_ALLOWED_ORIGINS` in the `ethos serve` environment and restart |
| Dashboard query returns data from a write statement | Plugin bypasses `registerDataSource` with direct DB access | Audit plugin code; route all queries through `registerDataSource` |

## See also

- [Security controls](./controls.md) -- the full catalogue of shipped controls.
- [Threat model](./threat-model.md) -- what Ethos defends against and what is out of scope.
- [How does Ethos defend against the threats it knows about?](./overview.md) -- the layered model and runtime precedence.
- [Pre-launch hardening pass](./security-fixes.md) -- sixteen issues surfaced and fixed before shipping.
- [Least-privilege tokens](./least-privilege-tokens.md) -- per-platform scope tables.
- [Bot token rotation playbook](./bot-token-rotation-playbook.md) -- step-by-step rotation procedure.
- [Why should agents never hold database credentials?](./api-mediated-access.md) -- reference architecture for API-mediated data access.
- [Why run one process per personality in production?](./process-isolation.md) -- when to split from shared-process to one-pod-per-personality.
