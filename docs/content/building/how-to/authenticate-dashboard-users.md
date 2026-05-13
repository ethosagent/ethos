---
title: "Authenticate your dashboard users"
description: "Add user authentication to a Mission Control dashboard while Ethos remains a single-user server."
kind: how-to
audience: developer
slug: authenticate-dashboard-users
time: "10 min"
updated: 2026-05-13
---

## Task

Add your own authentication layer (Clerk, Auth.js, or any provider) to the Mission Control dashboard so multiple people can access it — while understanding that Ethos itself is not multi-user.

## Result

Dashboard visitors log in through your auth provider before accessing Ethos data. Unauthenticated requests never reach the Ethos API.

## Prereqs

- A running Mission Control (see [Build your first Mission Control](../tutorials/first-mission-control.md)).
- An auth provider account (Clerk, Auth.js/NextAuth, or equivalent).

## Security model

:::warning
Ethos is a single-user server. There is no concept of per-user permissions, per-user sessions, or per-user memory inside Ethos. An API key grants full access to every scope it carries — sessions, memory, tool execution, personality switching. Anyone who holds the key has the same access as the Ethos owner.
:::

| Layer | Auth model | What it controls |
|-------|-----------|-----------------|
| **Your dashboard** | Multi-user (Clerk, Auth.js, etc.) | Who can open the dashboard |
| **Ethos server** | Single-user (one API key = full access) | What the dashboard can do |

Your auth layer protects the dashboard. It does not protect Ethos from a leaked API key. Treat the API key like a database password — do not embed it in client-side code that untrusted users can inspect.

## Steps

### 1. Move the API key server-side

The example Mission Control stores the API key in `NEXT_PUBLIC_ETHOS_API_KEY`, which is visible in the browser bundle. For a multi-user dashboard, move it behind a server-side proxy:

```typescript
// src/app/api/ethos/[...path]/route.ts
import { NextRequest, NextResponse } from 'next/server';

const ETHOS_BASE = process.env.ETHOS_BASE_URL!;     // no NEXT_PUBLIC_ prefix
const ETHOS_KEY = process.env.ETHOS_API_KEY!;        // server-only

export async function POST(req: NextRequest) {
  // your auth check here — reject if not authenticated
  const body = await req.json();

  const res = await fetch(`${ETHOS_BASE}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ETHOS_KEY}`,
    },
    body: JSON.stringify(body),
  });

  return NextResponse.json(await res.json());
}
```

The API key never leaves the server. The browser talks to your Next.js API route, which proxies to Ethos.

### 2. Add auth middleware

With Clerk:

```typescript
// middleware.ts
import { clerkMiddleware } from '@clerk/nextjs/server';

export default clerkMiddleware();

export const config = {
  matcher: ['/((?!_next|favicon.ico).*)'],
};
```

With Auth.js:

```typescript
// middleware.ts
export { auth as middleware } from '@/auth';
```

Both approaches gate every route. Unauthenticated visitors are redirected to the login page.

### 3. Gate the API proxy

Check authentication inside the proxy route:

```typescript
// Clerk example
import { auth } from '@clerk/nextjs/server';

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // proxy to Ethos
}
```

### 4. Adjust the client

Point `EthosClient` at your proxy instead of Ethos directly:

```typescript
const ethos = new EthosClient({
  baseUrl: '/api/ethos',  // your Next.js API route
  // no apiKey — the proxy adds it server-side
});
```

For SSE, you need a separate proxy path that streams the response body. The proxy sets the `Authorization` header; the browser receives the event stream without seeing the key.

### 5. Audit logging (optional)

Log which dashboard user triggered each Ethos action:

```typescript
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  console.log(`[ethos-proxy] user=${userId} action=${req.url}`);
  // ...
}
```

Ethos does not know about your users. Any audit trail that maps dashboard users to Ethos actions must live in your proxy layer.

## What this does NOT do

- **Per-user Ethos sessions** — all dashboard users share the same Ethos session pool. One user can see and delete another user's sessions.
- **Per-user memory** — MEMORY.md and USER.md are shared. Ethos has one memory scope per personality, not per dashboard user.
- **Permission scoping** — the API key grants the same access to every authenticated user. Role-based access (e.g., read-only for some users) must be enforced in your proxy layer.

If your use case requires true multi-user isolation, run a separate Ethos instance per user.
