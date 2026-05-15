---
title: "Migrate from cookie auth to API key"
description: "Switch existing SDK code from cookie-based authentication to bearer-token API key auth."
kind: how-to
audience: developer
slug: migrate-cookie-to-api-key
time: "5 min"
updated: 2026-05-13
---

## Task

Switch an existing Mission Control or SDK client from cookie-based authentication (the default when no `apiKey` is passed) to bearer-token authentication with a minted API key.

## Result

RPC calls send `Authorization: Bearer sk-ethos-...` instead of `credentials: 'include'`. The client works without browser cookies.

## Prereqs

- An existing codebase using `EthosClient` without an `apiKey`.
- Access to the Ethos CLI to mint a key.

## Background

When `EthosClient` is constructed without an `apiKey`, it falls back to cookie-based auth — every `fetch` call includes `credentials: 'include'`, relying on the browser sending the Ethos session cookie. This works when the dashboard and Ethos share the same origin or the browser has a valid cookie, but breaks in three cases:

1. **Server-side rendering** — Node.js does not have browser cookies.
2. **Cross-origin deployments** — the dashboard and Ethos run on different domains.
3. **Non-browser clients** — scripts, CLI tools, or mobile apps.

API key auth solves all three. The key is sent as a header on every request, independent of cookies.

## Steps

### 1. Mint an API key

```bash
ethos apikey create \
  --name "my-dashboard" \
  --scopes sessions:read,sessions:write,chat:send,personalities:read,memory:read,events:subscribe \
  --allowed-origins http://localhost:3001
```

Copy the `sk-ethos-...` secret.

### 2. Update EthosClient

Before:

```typescript
const ethos = new EthosClient({
  baseUrl: 'http://localhost:3000',
  // no apiKey — uses cookie auth
});
```

After:

```typescript
const ethos = new EthosClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.NEXT_PUBLIC_ETHOS_API_KEY,
});
```

When `apiKey` is set, the client sends `Authorization: Bearer <key>` on every RPC call. It no longer sets `credentials: 'include'`.

### 3. Update EventStream

`EventStream` accepts `apiKey` independently:

Before:

```typescript
const sub = EventStream({
  baseUrl: ethos.baseUrl,
  sessionId,
  onEvent: handleEvent,
  // no apiKey — uses cookie auth
});
```

After:

```typescript
const sub = EventStream({
  baseUrl: ethos.baseUrl,
  apiKey: process.env.NEXT_PUBLIC_ETHOS_API_KEY,
  sessionId,
  onEvent: handleEvent,
});
```

### 4. Remove cookie-dependent code

If your code sets `credentials`, `withCredentials`, or cookie-forwarding headers, remove them. The SDK handles auth mode automatically based on whether `apiKey` is present.

## Verify

Open the browser Network tab. RPC requests show `Authorization: Bearer sk-ethos-...`. SSE requests show the same header. No `Cookie` header is present on cross-origin requests.

```typescript
const { sessions } = await ethos.rpc.sessions.list({ limit: 5 });
console.log('Sessions:', sessions.length); // works without cookies
```
