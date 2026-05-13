---
title: "Build your first Mission Control in 15 minutes"
description: "Clone the SDK repo, install dependencies, mint an API key, configure .env, run the example Mission Control, and see sessions, chat, and memory working end to end."
kind: tutorial
audience: developer
slug: first-mission-control
time: "15 min"
updated: 2026-05-13
---

Start with the example Mission Control — a three-panel Next.js dashboard that talks to a running Ethos server over RPC and SSE. By minute fifteen you have sessions listing, live chat streaming, personality switching, and memory inspection all working in the browser.

## Goal

By the end, you have:

- A running Ethos server with the web API enabled.
- A minted API key with the correct scopes and allowed origin.
- The example Mission Control running on `localhost:3001`, connected to Ethos on `localhost:3000`.
- Live chat that streams tool events and assistant responses via SSE.
- Session listing, creation, and deletion working through the SDK's RPC client.
- Memory (MEMORY.md and USER.md) visible in the side panel.

## Prereqs

- Node 24+. Check with `node --version`.
- pnpm 10. `corepack enable` or `npm install -g pnpm@10`.
- A running Ethos server. Either `pnpm dev` from the monorepo root or `ethos serve` from a binary install.
- An LLM provider configured in Ethos (`~/.ethos/config.yaml` with a valid Anthropic/OpenAI key).

## 1. Clone and install the SDK repo

```bash
git clone https://github.com/MiteshSharma/control-plane-sdk.git
cd control-plane-sdk
pnpm install
```

The workspace resolves `@ethosagent/sdk` and `@ethosagent/web-contracts` from `packages/`. No published npm packages are required.

## 2. Start Ethos with the web API

In a separate terminal, start the Ethos server:

```bash
# From the ethos monorepo
ethos serve
```

Confirm it is running:

```bash
curl http://localhost:3000/rpc
```

A JSON response (even an error shape) means the server is up.

## 3. Mint an API key

The Mission Control authenticates with a bearer token, not browser cookies. Mint a key from the Ethos CLI:

```bash
ethos apikey create \
  --name "mission-control-dev" \
  --scopes sessions:read,sessions:write,chat:send,personalities:read,memory:read,memory:write,events:subscribe \
  --allowed-origins http://localhost:3001
```

Copy the returned `sk-ethos-...` secret. This is shown once — store it somewhere safe.

The `--allowed-origins` flag is mandatory. It pins the key to requests originating from `http://localhost:3001`. Requests from other origins are rejected, even with a valid key.

## 4. Configure .env

```bash
cd examples/mission-control
cp .env.example .env.local
```

Edit `.env.local`:

```env
NEXT_PUBLIC_ETHOS_BASE_URL=http://localhost:3000
NEXT_PUBLIC_ETHOS_API_KEY=sk-ethos-your-key-here
```

Replace `sk-ethos-your-key-here` with the key from step 3.

Both variables are prefixed `NEXT_PUBLIC_` because the SDK client runs in the browser. The API key is visible in client-side JavaScript — this is intentional for local development. For production deployments, see [Deploy Mission Control with a remote Ethos](../how-to/deploy-mission-control-remote.md).

## 5. Start the dashboard

```bash
pnpm dev
```

Open [http://localhost:3001](http://localhost:3001). Three panels appear:

| Panel | Component | What it does |
|-------|-----------|--------------|
| Left | `SessionList` | Lists sessions from `ethos.rpc.sessions.list()`. Click to activate. |
| Center | `ChatPanel` | Sends messages via `ethos.rpc.chat.send()`, streams responses via `EventStream`. |
| Right | `SidePanel` | Picks a personality from `ethos.rpc.personalities.list()`, shows MEMORY.md and USER.md from `ethos.rpc.memory.list()`. |

## 6. Send your first message

Type a message in the center panel and press Enter. The SDK fires a `chat.send` RPC:

```typescript
const res = await ethos.rpc.chat.send({
  sessionId: sessionId ?? undefined,
  clientId: 'mission-control',
  text,
  personalityId: personalityId ?? undefined,
});
```

The server returns a `sessionId` and `turnId`. The `ChatPanel` subscribes to SSE on that session:

```typescript
const sub = EventStream({
  baseUrl: ethos.baseUrl,
  apiKey: process.env.NEXT_PUBLIC_ETHOS_API_KEY ?? '',
  sessionId,
  onEvent: handleEvent,
  onError: (err) => console.error('SSE error:', err),
});
```

Events stream in: `text_delta` (token-by-token text), `tool_start` / `tool_end` (tool execution), and `done` (turn complete). The chat panel renders each in real time.

## 7. Explore sessions and memory

Click the **Refresh** button in the left panel. Your new session appears — identified by the first 8 characters of its ID. Click it to reload the chat for that session.

In the right panel, select a personality from the dropdown. Below it, MEMORY.md and USER.md display the current memory content for that personality scope. Ask the agent to remember something, then click **Refresh** — the memory content updates.

## 8. Understand the wiring

The entire SDK connection lives in one file — `src/lib/ethos.ts`:

```typescript
import { EthosClient } from '@ethosagent/sdk';

export const ethos = new EthosClient({
  baseUrl: process.env.NEXT_PUBLIC_ETHOS_BASE_URL ?? 'http://localhost:3000',
  apiKey: process.env.NEXT_PUBLIC_ETHOS_API_KEY ?? '',
});
```

`EthosClient` provides:

- **`ethos.rpc`** — a typed RPC client. Every namespace (`sessions`, `chat`, `personalities`, `memory`, `tools`, etc.) is fully typed from the `@ethosagent/web-contracts` contract. TypeScript autocomplete covers every method and its input/output shapes.
- **`ethos.baseUrl`** — passed to `EventStream` for SSE subscriptions.

`EventStream` is a separate function export from `@ethosagent/sdk`. It opens an SSE connection to `/sse/sessions/:id`, parses each `data:` line against `SseEventSchema`, and calls `onEvent` with typed events.

## Troubleshooting

**Connection refused on localhost:3000** — Ethos is not running. Start it with `ethos serve` or `pnpm dev` in the monorepo.

**401 Unauthorized** — The API key is missing or invalid. Re-check `.env.local`. Make sure `NEXT_PUBLIC_ETHOS_API_KEY` matches the minted key exactly.

**403 Forbidden (origin mismatch)** — The `allowedOrigins` on the key does not include `http://localhost:3001`. Revoke and re-create the key with the correct origin.

**SSE connects but no events appear** — Check the browser console for errors. Common cause: the `events:subscribe` scope is missing from the key.

## What you learned

- `EthosClient` wraps an oRPC client typed against `@ethosagent/web-contracts`.
- `EventStream` opens an SSE connection with automatic reconnect and resume (via `Last-Event-ID`).
- API keys are scoped by capability and pinned to allowed origins.
- The three-panel layout is a starting point — fork it and reshape for your use case.

## Where to next

The example is a template, not a final product. Build on it:

- [Point the SDK at a running Ethos](../how-to/point-sdk-at-ethos.md) — env var precedence, multi-instance setups, and TLS.
- [Add a new panel to Mission Control](../how-to/add-a-panel.md) — create a React component, wire RPC calls, and add it to the grid.
- [Display live tool events](../how-to/display-live-tool-events.md) — subscribe to SSE and render tool cards with status.
- [Authenticate your dashboard users](../how-to/authenticate-dashboard-users.md) — add your own auth layer while Ethos stays single-user.
- [Deploy Mission Control with a remote Ethos](../how-to/deploy-mission-control-remote.md) — run the dashboard and Ethos on separate machines.
- [Build a Python client with OpenAPI](../how-to/build-a-python-client.md) — generate a typed Python SDK from the `/openapi` endpoint.
- [Migrate from cookie auth to API key](../how-to/migrate-cookie-to-api-key.md) — switch existing code from cookie-based auth to bearer tokens.
