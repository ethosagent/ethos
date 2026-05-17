---
title: "Build a custom ops dashboard with the SDK"
description: "Use @ethosagent/sdk to fetch sessions, stream chat events live, and send a message — a focused ops dashboard in under 15 minutes."
kind: tutorial
audience: developer
slug: build-custom-dashboard
time: "15 min"
updated: 2026-05-17
---

In fifteen minutes you have a small live ops dashboard: a session list on the left, a streaming chat panel on the right, and a working "send a message" box at the bottom. No framework lock-in — the same SDK calls run in React, Vue, Svelte, or plain HTML.

This tutorial is the "now actually build something" companion to the [reference Mission Control template](./first-mission-control.md). Where that one runs the canonical three-panel Next.js example end-to-end, this one walks through the SDK calls so you can shape your own UI on top of them — an ops view, a digest, a single-purpose pane for one team.

## Goal

By the end you have:

- A typed `EthosClient` connected to a running Ethos server.
- A function that lists sessions and renders them.
- A function that streams chat events for a selected session and surfaces text deltas as they arrive.
- A function that sends a new message and watches it stream back.

## Prereqs

- Node 24+ and pnpm 10.
- A running Ethos server with the web API enabled — `ethos serve --web-experimental --web-port 3000`.
- An API key with the scopes a dashboard needs: `sessions:read`, `chat:send`, `events:subscribe`.

If you do not yet have a key, mint one before starting:

```bash
ethos api-key create \
  --name "my-dashboard" \
  --scopes sessions:read,chat:send,events:subscribe
```

Copy the printed `sk-ethos-...` secret. It is shown once.

## 1. Install the SDK

In a fresh project directory:

```bash
pnpm init
pnpm add @ethosagent/sdk
```

The SDK ships its own typed RPC contract — no separate `web-contracts` install needed.

## 2. Instantiate the client

Create `src/ethos.ts`:

```typescript
import { EthosClient } from '@ethosagent/sdk';

export const ethos = new EthosClient({
  baseUrl: process.env.ETHOS_BASE_URL ?? 'http://localhost:3000',
  apiKey: process.env.ETHOS_API_KEY ?? '',
});
```

`EthosClient` wraps an [oRPC](https://orpc.unnoq.com/) link — every namespace on `ethos.rpc` is typed end-to-end against the contract in `@ethosagent/web-contracts`. You get autocomplete for every method and its input/output.

For the full surface, see [SDK client reference](../reference/sdk-client.md).

## 3. List sessions

```typescript
import { ethos } from './ethos';

async function loadSessions() {
  const { sessions } = await ethos.rpc.sessions.list({ limit: 20 });
  return sessions;
}

// Render however you like:
for (const s of await loadSessions()) {
  console.log(`${s.id.slice(0, 8)}  ${s.title ?? '(untitled)'}  ${s.lastActivityAt}`);
}
```

`sessions.list` is paginated (`cursor` for the next page) and supports FTS5 search via `q`. In a UI, render each session as a row; clicking sets the active `sessionId`.

## 4. Stream events for the active session

`EventStream` opens a server-sent event connection to one session and dispatches typed events to a callback. It is exported separately from `EthosClient` — pass `baseUrl` and `apiKey` directly:

```typescript
import { EventStream } from '@ethosagent/sdk';

function watchSession(sessionId: string, onText: (delta: string) => void) {
  return EventStream({
    baseUrl: process.env.ETHOS_BASE_URL ?? 'http://localhost:3000',
    apiKey: process.env.ETHOS_API_KEY ?? '',
    sessionId,
    onEvent(event) {
      switch (event.type) {
        case 'text_delta':
          onText(event.text);
          break;
        case 'tool_start':
          console.log(`[tool] ${event.toolName} started`);
          break;
        case 'tool_end':
          console.log(`[tool] ${event.toolName} ${event.ok ? 'ok' : 'failed'} (${event.durationMs}ms)`);
          break;
        case 'done':
          console.log('--- turn complete ---');
          break;
        case 'error':
          console.error(`error: ${event.error}`);
          break;
      }
    },
    onError(err) {
      console.error('stream error:', err);
    },
  });
}

const sub = watchSession('ses_abc123', (delta) => process.stdout.write(delta));
```

The subscription returned by `EventStream` carries:

- `sub.lastSeq` — the sequence number of the last delivered event (useful for resume).
- `sub.closed` — `true` once the stream is intentionally closed.
- `sub.close()` — stop the stream. Always call this on unmount.

Reconnection is automatic. If the connection drops, the SDK retries every 3 seconds and resumes from `lastSeq` via the `Last-Event-ID` header. See [EventStream reference](../reference/sdk-event-stream.md) for the full event union.

## 5. Send a message

`chat.send` starts a turn and returns immediately. The actual response streams through the `EventStream` you opened in step 4 — that is the seam that decouples the request from the response:

```typescript
async function sendMessage(sessionId: string | null, text: string) {
  const res = await ethos.rpc.chat.send({
    sessionId: sessionId ?? undefined,
    clientId: 'my-ops-dashboard',
    text,
  });
  return res.sessionId;  // server may have minted a new session
}

const newSessionId = await sendMessage(null, 'Summarize the kanban board.');
const sub = watchSession(newSessionId, (delta) => process.stdout.write(delta));
```

Pattern:

1. Call `chat.send` first. Capture the returned `sessionId`.
2. Open an `EventStream` against that `sessionId` if you have not already.
3. Text deltas, tool events, and the terminal `done` event arrive over the stream.

`clientId` is your dashboard's identifier — it appears in observability output and helps disambiguate two tabs talking to the same session.

## 6. Putting it together

Minimal end-to-end script — `src/index.ts`:

```typescript
import { EventStream } from '@ethosagent/sdk';
import { ethos } from './ethos';

const apiKey = process.env.ETHOS_API_KEY ?? '';
const baseUrl = process.env.ETHOS_BASE_URL ?? 'http://localhost:3000';

async function main() {
  const { sessions } = await ethos.rpc.sessions.list({ limit: 5 });
  console.log(`${sessions.length} recent sessions:`);
  for (const s of sessions) console.log(`  ${s.id.slice(0, 8)}  ${s.title ?? '(untitled)'}`);

  const { sessionId } = await ethos.rpc.chat.send({
    clientId: 'demo-dashboard',
    text: 'What time is it?',
  });

  console.log(`streaming session ${sessionId}:\n`);

  await new Promise<void>((resolve) => {
    const sub = EventStream({
      baseUrl,
      apiKey,
      sessionId,
      onEvent(event) {
        if (event.type === 'text_delta') process.stdout.write(event.text);
        if (event.type === 'done') { sub.close(); resolve(); }
      },
      onError(err) {
        console.error('stream error:', err);
        sub.close();
        resolve();
      },
    });
  });
}

void main();
```

Run it:

```bash
ETHOS_API_KEY=sk-ethos-... pnpm tsx src/index.ts
```

You see the recent session list, then the assistant's response streaming token-by-token until `done`.

## What you learned

- `EthosClient` is a typed RPC client over oRPC — every method is checked against the shared contract.
- `EventStream` is a separate function. It takes `baseUrl` and `apiKey` directly so you can stream without holding a client.
- The chat flow is two calls: `chat.send` starts the turn, `EventStream` delivers the response. They are decoupled on purpose — multiple subscribers can watch the same session.
- The same SDK calls render in any UI framework. Pick your renderer; the data layer is unchanged.

## Next step

- [Build your first Mission Control](./first-mission-control.md) — the full three-panel Next.js example, end to end.
- [Add a new panel to Mission Control](../how-to/add-a-panel.md) — drop a custom panel into the reference layout.
- [Display live tool events](../how-to/display-live-tool-events.md) — render tool cards with start, progress, end, and result.
- [Authenticate your dashboard users](../how-to/authenticate-dashboard-users.md) — add your own auth layer on top of single-user Ethos.
- [Deploy Mission Control with a remote Ethos](../how-to/deploy-mission-control-remote.md) — production deployment patterns.
- [SDK client reference](../reference/sdk-client.md) — full RPC surface, stable vs experimental namespaces.
- [EventStream reference](../reference/sdk-event-stream.md) — every event type and their payload fields.
