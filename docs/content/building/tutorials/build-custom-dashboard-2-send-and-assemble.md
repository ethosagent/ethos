---
title: "Build a custom ops dashboard with the SDK, part 2: send a message and put it together"
description: "Send a message through the SDK and assemble the dashboard."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 5-6 of [Build a custom ops dashboard with the SDK](build-custom-dashboard.md): Send a message; Putting it together.

## Prereqs

- Complete [part 1 of 2](build-custom-dashboard.md).

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
