---
title: Why agents should never hold database credentials
description: Reference architecture for API-mediated data access — agents call internal services that hold credentials and enforce row-level authorization.
kind: explanation
audience: shared
slug: api-mediated-access
updated: 2026-05-18
---

An AI agent with a raw database connection string can read any table, write any row, and leak credentials through [tool](../getting-started/glossary.md#tool) results or memory context. No row-level authorization, no audit trail at the data layer, no way to revoke access without rotating the entire connection string. This page explains why that is the wrong architecture and what the right one looks like.

## Context

Production databases are the highest-value target in most systems. They hold user data, billing records, API keys, access logs — the kind of material where a single unauthorized read is a reportable incident. Traditional services protect databases behind application layers that enforce authentication, authorization, and audit. Agent frameworks often skip this step: the agent gets a connection string, a SQL tool, and a system prompt that says "be careful."

That is not a security control. The system prompt is advisory; the LLM can be coerced (see [What is the threat model?](./threat-model.md)). The connection string in the agent's environment is a credential that persists in memory, in session history, and potentially in tool results that flow back to the LLM context. The [credential redaction](./controls.md#credential-redaction) layer catches known key formats, but a Postgres connection URI (`postgres://user:pass@host:5432/db`) is not a fixed-format secret — it varies by host, port, username, and encoding, making reliable pattern-based redaction fragile.

The recommended pattern for Ethos deployments that need database access is **API-mediated access**: the agent never touches the database directly. It calls a thin internal service that holds credentials, enforces authorization, and logs every operation.

## Discussion

### The failure modes of direct database access

When an agent holds a database connection string, four things go wrong simultaneously.

**No authorization boundary.** The connection authenticates as a database user, not as the agent or the human the agent acts for. Every query runs with the privileges of that database user. Row-level security policies in Postgres can help, but they require the application to set `current_setting('app.user_id')` per transaction — which means the agent needs to know the current user's ID and set it correctly on every query. One missed `SET` and the query runs as the default role.

**No audit trail at the right layer.** Database query logs record SQL statements and the database user. They do not record which [personality](../getting-started/glossary.md#personality) issued the query, which [session](../getting-started/glossary.md#session) it belonged to, which human's request triggered it, or what the agent was trying to accomplish. Reconstructing "why did the agent read the payments table?" from a Postgres slow-query log is forensics, not observability.

**Credential exposure surface.** The connection string lives in the agent's environment — `config.yaml`, an environment variable, a [secret](../getting-started/glossary.md#secret) ref. It enters the LLM context if a tool error includes it. It persists in session history if the agent reasons about it. It leaks to third-party [skills](../getting-started/glossary.md#skill) if they can read environment variables. Rotating the credential means restarting every agent that holds it.

**Blast radius.** A compromised agent — whether through indirect prompt injection, a malicious skill, or an operator mistake — has the same database access as a legitimate one. There is no per-request authorization to constrain what a hijacked agent can do. The [watcher](./controls.md#watcher) can terminate a runaway [turn](../getting-started/glossary.md#turn), but it cannot distinguish "legitimate bulk read" from "exfiltration" at the SQL layer.

### The pattern: API-mediated access

The agent does not connect to the database. It calls an internal API service that sits between the agent and the data store.

```
┌───────────┐         ┌──────────────────────┐         ┌──────────┐
│           │  HTTPS   │   Internal API       │         │          │
│   Agent   │────────→│   Service            │────────→│ Database │
│           │         │                      │         │          │
└───────────┘         │  • Holds DB creds    │         └──────────┘
                      │  • Validates caller  │
                      │  • Row-level ACL     │
                      │  • Audit log         │
                      └──────────────────────┘
```

The API service is the only component that holds database credentials. It performs four functions.

**Caller authentication.** Every request from the agent carries an identity — a per-agent API key, a personality ID, a session token, or an OAuth bearer token scoped to the agent's role. The API service validates that identity before executing any query. A request with no identity or an expired token is rejected before it reaches the database.

**Row-level authorization.** The API service enforces access rules at the application layer. A `researcher` personality can read public datasets but not billing records. An `operator` personality can read billing summaries but not raw payment instruments. The rules live in the API service's configuration, not in the database's row-level security policies — because the API service knows the caller's identity and role, and the database does not.

**Audit logging.** Every read and write is logged with the caller's identity, the personality ID, the session ID, the operation performed, and the rows affected. This log is the authoritative record of what data the agent accessed. It composes with Ethos's own `observability.db` — the agent-side audit records "I called the payments API," and the API-side audit records "personality:researcher read 12 rows from the invoices table."

**Credential isolation.** The database connection string never leaves the API service. The agent holds an API key scoped to its role — a credential that can be rotated per-agent, per-personality, or per-session without touching the database credential. Revoking an agent's access is a single API key deletion; no database password rotation required.

### How Ethos supports this pattern

Ethos does not ship a database tool, and that is deliberate. The framework provides the building blocks for API-mediated access without requiring changes to the core runtime.

**`web_fetch` for HTTP calls.** The agent calls the internal API service using `web_fetch` (or a custom MCP tool that wraps it). The request carries the agent's identity in a header — an API key from the personality's [secret](../getting-started/glossary.md#secret) refs, or a session-scoped token issued at [turn](../getting-started/glossary.md#turn) start. The tool result flows back through the standard [credential redaction](./controls.md#credential-redaction) and [provenance wrapping](./controls.md#provenance-wrapping) layers before it re-enters the LLM context, so sensitive fields in the API response are scrubbed even if the API service returns more than the agent needs.

**`network.allowedHosts` for egress control.** The personality's [network policy](./controls.md#per-personality-network-policy) restricts which hosts the agent can reach. A personality that needs the internal API service declares `api.internal.example.com` in its `networkReach`; everything else is denied. The agent cannot reach the database host directly — it is not in the allowlist. This is the structural enforcement that makes the pattern hold even when the LLM is coerced: a hijacked agent that tries to connect to `db.internal:5432` is rejected at the network layer before the TCP connection opens.

**SSRF protection for the API service.** If the API service itself makes outbound calls (webhooks, callbacks), Ethos's [SSRF controls](./controls.md#ssrf-protection) prevent the agent from instructing the API service to fetch from private IP ranges or cloud metadata endpoints. The agent cannot use the API service as an SSRF proxy.

**Custom MCP tools as typed wrappers.** For deployments that want stronger typing than raw `web_fetch`, a custom MCP tool can wrap the API service with a declared argument schema — `{ customerId: string, fields: string[] }` instead of a raw URL. The [personality](../getting-started/glossary.md#personality) registers the MCP tool in its `toolset.yaml`; the [tool registry](../getting-started/glossary.md#tool-registry) enforces that only personalities with the tool in their toolset can call it. The MCP tool holds the API base URL and the auth header internally; the agent never sees either.

**Personality-scoped identity.** Each personality can carry a distinct API key for the internal service, scoped to the personality's role. The `researcher` personality authenticates with a read-only key; the `operator` personality authenticates with a read-write key. The API service maps the key to an authorization policy. Switching personalities switches the credential and the access level atomically — this is why [personality is the unit](../getting-started/glossary.md#personality) of security scoping in Ethos, not the session or the user.

**Audit composition.** The agent's [tool calls](../getting-started/glossary.md#tool) are logged in `observability.db` with the personality ID, session ID, and tool arguments. The API service logs the same request with the rows accessed. Correlating the two logs by request ID gives a complete picture: what the agent intended, what the API service authorized, and what data moved.

### What happens when the agent is compromised

The value of API-mediated access is clearest in the compromise scenario. Consider an agent that has been hijacked via [indirect prompt injection](./threat-model.md) — a malicious email body instructs it to exfiltrate data.

With direct database access, the compromised agent can run arbitrary SQL. It can `SELECT *` from every table, dump credentials stored in the database, or `INSERT` poisoned records. The [watcher](./controls.md#watcher) may terminate the turn after detecting anomalous tool-call volume, but by then the data has already been read.

With API-mediated access, the compromised agent can only call the endpoints the API service exposes, authenticated as the personality's role. A `researcher` key cannot call the `POST /admin/users` endpoint. A read-only key cannot call any write endpoint. The API service's audit log records every request the compromised agent made, with the exact rows returned — giving the incident response team a precise blast radius instead of a database-wide forensics exercise.

### Why not just use database-level row-level security?

Database-level row-level security (RLS) is a defense-in-depth layer, not a replacement for API-mediated access. RLS policies depend on a session variable (`current_setting('app.user_id')` in Postgres, `INVOKER` in MySQL) being set correctly on every connection. The agent would need to set this variable before every query — and if it forgets, if the connection pool reuses a connection with a stale variable, or if the LLM generates a query that changes the variable, the policy fails open.

RLS also does not solve the audit, credential isolation, or blast-radius problems. It narrows what rows are visible; it does not log who asked or why, it does not isolate the database credential from the agent, and it does not let you revoke a single agent's access without rotating the database password.

Use RLS as a backstop inside the database. Use the API service as the primary enforcement point.

### The API service does not need to be complex

The internal API service is not a microservices platform. For most Ethos deployments, it is a thin HTTP server with three responsibilities:

- **Authenticate** the caller (validate the API key or token in the `Authorization` header).
- **Authorize** the request (check the caller's role against an access-control list for the requested resource).
- **Execute and log** the query (run the SQL, write the audit record, return the result).

A minimal implementation is a single-file Express or Fastify app with a middleware chain: auth middleware, ACL middleware, route handler. The database connection is a module-scoped pool. The audit log is a table in the same database or a separate append-only store.

The API service grows only when the access patterns grow — adding pagination, rate limiting, or field-level redaction as the deployment matures. It does not need to anticipate every future query; it needs to enforce "this caller can read these rows" today.

### Credential lifecycle

The pattern introduces two credential tiers.

| Tier | Held by | Scope | Rotation frequency | Revocation |
|---|---|---|---|---|
| Database credential | API service only | Full database access | Low (quarterly, or on compromise) | Rotate and restart the API service |
| Agent API key | Agent personality | Role-scoped API access | Higher (per-deployment, per-session) | Delete the key; agent loses access immediately |

The agent API key is the credential that moves. It can be issued per-personality, per-session, or per-deployment. It can be short-lived (a JWT with a 1-hour expiry) or long-lived (a static key in the personality's secret refs). The API service validates it on every request. Revoking it is instant and does not affect other agents or the database credential.

The database credential is the credential that stays still. It lives in the API service's environment, never in the agent's. Rotating it is a single-service restart, not a fleet-wide redeployment.

## Trade-offs

### When to apply this pattern

Not every Ethos deployment needs API-mediated access. A local CLI agent that reads from a personal SQLite file on disk does not justify an intermediate HTTP service. The pattern applies when any of these conditions hold: the database contains data belonging to multiple users, unauthorized reads are reportable incidents (PII, financial data, health records), the agent runs as a [channel](../getting-started/glossary.md#channel-adapter) bot reachable over the network, or multiple personalities need different access levels to the same data store. When none of these conditions hold, the deployment complexity is not justified.

### An additional service to operate

The API service is a new component in the deployment. It needs to be deployed, monitored, and maintained. For a single-agent local-CLI deployment, this may be overhead that exceeds the risk. The pattern is most valuable when the agent runs on a server, handles requests from multiple users, or accesses data where unauthorized reads are reportable incidents.

### Latency per data access

Every database read now includes an HTTP round-trip to the API service. For most agent workloads — where the LLM round-trip dominates latency — the additional milliseconds are negligible. For tight loops that make hundreds of small reads per turn, the overhead is measurable. Batch endpoints in the API service (accept a list of IDs, return a list of rows) mitigate this without bypassing the authorization layer.

### The API surface becomes a security boundary

The API service's endpoints define what data the agent can access. A missing endpoint means the agent cannot read that data — which is the point, but also means the API surface must evolve alongside the agent's capabilities. Adding a new data source to the agent requires adding an endpoint to the API service first. This is a feature when you want explicit control; it is friction when you want rapid iteration.

### Pattern-based redaction is not a substitute

Ethos's [credential redaction](./controls.md#credential-redaction) catches known secret formats (`sk-ant-...`, `AKIA...`, bearer tokens). A database connection URI is not a fixed-format secret. Relying on redaction to catch a leaked connection string is fragile — the redaction layer is a safety net, not a primary control. The primary control is never giving the agent the connection string in the first place.

## Anti-patterns {#anti-patterns}

These are the patterns this architecture is designed to prevent. If you find any of them in an Ethos deployment, treat it as a security gap.

**Connection string in `config.yaml` or environment variables accessible to the agent.** The agent's configuration should contain an API key for the internal service, not a database URI. If the agent can read its own config (via file tools or environment inspection), a database URI in that config is a credential exposure.

**Database port in `network.allowedHosts`.** If the personality's network policy includes `db.internal:5432` or `localhost:5432`, the agent can reach the database directly — even if no SQL tool is registered. A custom MCP tool or a `web_fetch` to a non-standard port can bypass the "no SQL tool" assumption.

**A database admin tool in the agent's toolset.** Tools like `sql_query`, `db_exec`, or a generic "run this SQL" tool give the agent direct database access regardless of the API service. If the personality's `toolset.yaml` includes such a tool, the API-mediated pattern is bypassed.

**No audit logging in the API service.** An API service that authenticates and authorizes but does not log is half the pattern. Without the API-side audit log, the "what data did the agent access?" question has no authoritative answer. The agent-side `observability.db` records "I called the API"; only the API-side log records "and the API returned these rows."

**Shared API keys across personalities.** If the `researcher` and the `operator` use the same API key, the API service cannot distinguish their access levels. Per-personality keys are what make role-scoped authorization work. A shared key collapses the authorization boundary to a single role.

## See also {#see-also}

- [Security controls](./controls.md) — the full catalogue of shipped controls, including [network policy](./controls.md#per-personality-network-policy) and [credential redaction](./controls.md#credential-redaction).
- [What is the threat model?](./threat-model.md) — what Ethos defends against and what is out of scope.
- [How does Ethos defend against the threats it knows about?](./overview.md) — the layered model and runtime precedence diagram.
