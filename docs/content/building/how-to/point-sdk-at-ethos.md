---
title: "Point the SDK at a running Ethos"
description: "Configure EthosClient to connect to a local, remote, or multi-instance Ethos server with the correct base URL and API key."
kind: how-to
audience: developer
slug: point-sdk-at-ethos
time: "5 min"
updated: 2026-05-13
---

## Task

Configure `EthosClient` from `@ethosagent/sdk` to connect to an Ethos server — whether it runs on localhost, a remote machine, or across multiple instances.

## Result

`ethos.rpc.sessions.list()` returns without error. `EventStream` connects and receives events.

## Prereqs

- `@ethosagent/sdk` installed (`pnpm add @ethosagent/sdk`).
- A running Ethos server with the web API enabled (`ethos serve`).
- A minted API key (see step 3 below).

## Steps

### 1. Construct the client

`EthosClient` accepts three options:

```typescript
import { EthosClient } from '@ethosagent/sdk';

const ethos = new EthosClient({
  baseUrl: 'http://localhost:3000',  // required
  apiKey: 'sk-ethos-...',           // optional — falls back to cookie auth
  fetch: customFetch,               // optional — override the global fetch
});
```

| Option | Type | Default |
|--------|------|---------|
| `baseUrl` | `string` | None (required) |
| `apiKey` | `string \| undefined` | `undefined` — uses `credentials: 'include'` for cookie auth |
| `fetch` | `typeof globalThis.fetch` | `globalThis.fetch` |

### 2. Env var precedence

Set `baseUrl` and `apiKey` from environment variables with explicit constructor args as the override:

```typescript
const ethos = new EthosClient({
  baseUrl: process.env.NEXT_PUBLIC_ETHOS_BASE_URL ?? 'http://localhost:3000',
  apiKey: process.env.NEXT_PUBLIC_ETHOS_API_KEY ?? undefined,
});
```

Precedence (highest to lowest):

1. **Explicit constructor args** — always win.
2. **Environment variables** — `NEXT_PUBLIC_ETHOS_BASE_URL`, `NEXT_PUBLIC_ETHOS_API_KEY` (for Next.js), or any names you choose for other frameworks.
3. **Localhost default** — `http://localhost:3000` is the conventional fallback when nothing is set.

There is no built-in env var auto-read. The client takes explicit values; your code decides where they come from.

### 3. Mint an API key

From the Ethos CLI:

```bash
ethos apikey create \
  --name "my-dashboard" \
  --scopes sessions:read,sessions:write,chat:send,personalities:read,memory:read,events:subscribe \
  --allowed-origins http://localhost:3001
```

Available scopes: `sessions:read`, `sessions:write`, `chat:send`, `personalities:read`, `memory:read`, `memory:write`, `tools:approve`, `events:subscribe`.

The `--allowed-origins` flag pins the key to specific origins. Every browser request includes an `Origin` header; the server rejects requests whose origin is not in the key's allowlist.

### 4. Deployment shapes

#### Local development

Ethos on `localhost:3000`, dashboard on `localhost:3001`:

```typescript
const ethos = new EthosClient({
  baseUrl: 'http://localhost:3000',
  apiKey: 'sk-ethos-...',
});
```

Allowed origin: `http://localhost:3001`.

#### Remote server with TLS

Ethos behind a reverse proxy with TLS:

```typescript
const ethos = new EthosClient({
  baseUrl: 'https://ethos.internal.example.com',
  apiKey: 'sk-ethos-...',
});
```

Allowed origin: `https://dashboard.example.com`.

Do not expose Ethos to the public internet without TLS. The API key travels in the `Authorization` header — without TLS, it is visible to anyone on the network path. See [Deploy Mission Control with a remote Ethos](./deploy-mission-control-remote.md).

#### Multiple instances

Connect to different Ethos servers from the same application:

```typescript
const staging = new EthosClient({
  baseUrl: 'https://ethos-staging.internal.example.com',
  apiKey: process.env.STAGING_API_KEY,
});

const production = new EthosClient({
  baseUrl: 'https://ethos-prod.internal.example.com',
  apiKey: process.env.PROD_API_KEY,
});
```

Each client is independent. They do not share connection state.

### 5. EventStream connection

`EventStream` takes `baseUrl` and `apiKey` separately — it does not read from `EthosClient`:

```typescript
import { EventStream } from '@ethosagent/sdk';

const sub = EventStream({
  baseUrl: ethos.baseUrl,
  apiKey: 'sk-ethos-...',
  sessionId: 'session-abc',
  onEvent: (event, seq) => console.log(event),
  onError: (err) => console.error(err),
});
```

Pass `ethos.baseUrl` to keep the two in sync. The SSE endpoint is `GET /sse/sessions/:id`.

## Verify

```typescript
const { sessions } = await ethos.rpc.sessions.list({ limit: 1 });
console.log(sessions.length, ethos.baseUrl);
```

Runs without throwing. With a deliberately wrong `apiKey`, the call fails with `401 Unauthorized`; with the wrong `Origin`, `403 Forbidden`.

## Troubleshooting

**`ECONNREFUSED` on `localhost:3000`** — Ethos is not running. Start it with `ethos serve` or `pnpm dev` in the monorepo. If Ethos runs on a different port, update `baseUrl`.

**`401 Unauthorized`** — The API key is invalid, expired, or revoked. List active keys with `ethos apikey list`.

**`403 Forbidden`** — Origin mismatch. The request's `Origin` header is not in the key's `allowedOrigins`. Re-mint the key with the correct origin.

**SSE connects but immediately closes** — Check that the `events:subscribe` scope is on the key. Without it, the server rejects the SSE handshake.
