---
title: "Display live tool events"
description: "Subscribe to SSE via EventStream, handle tool_start, tool_end, and tool_progress events, and render tool cards with live status."
kind: how-to
audience: developer
slug: display-live-tool-events
time: "10 min"
updated: 2026-05-13
---

## Task

Subscribe to the Ethos SSE stream and render tool execution events in real time — showing which tools are running, their progress, and whether they succeeded or failed.

## Result

Tool cards appear in the UI as tools execute: a "running" state on `tool_start`, optional progress updates on `tool_progress`, and a final "completed" or "failed" state on `tool_end`.

## Prereqs

- `@ethosagent/sdk` installed.
- A running Ethos server with an active session.
- A valid API key with the `events:subscribe` scope.

## Steps

### 1. Subscribe to EventStream

```typescript
import { EventStream } from '@ethosagent/sdk';
import type { SseEvent } from '@ethosagent/web-contracts';

const sub = EventStream({
  baseUrl: 'http://localhost:3000',
  apiKey: 'sk-ethos-...',
  sessionId: 'your-session-id',
  onEvent: handleEvent,
  onError: (err) => console.error('SSE error:', err),
});
```

`EventStream` opens an SSE connection to `GET /sse/sessions/:id`. It reconnects automatically on disconnect, resuming from the last received sequence number via `Last-Event-ID`.

Call `sub.close()` to disconnect.

### 2. Handle tool events

Three event types carry tool execution data:

```typescript
interface ToolCard {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  args?: unknown;
  progress?: string;
  percent?: number;
  durationMs?: number;
  result?: string;
}

const toolCards = new Map<string, ToolCard>();

function handleEvent(event: SseEvent) {
  switch (event.type) {
    case 'tool_start':
      toolCards.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: 'running',
        args: event.args,
      });
      break;

    case 'tool_progress':
      // tool_progress does not carry toolCallId — match by toolName
      for (const card of toolCards.values()) {
        if (card.toolName === event.toolName && card.status === 'running') {
          card.progress = event.message;
          card.percent = event.percent;
        }
      }
      break;

    case 'tool_end':
      const card = toolCards.get(event.toolCallId);
      if (card) {
        card.status = event.ok ? 'completed' : 'failed';
        card.durationMs = event.durationMs;
        card.result = event.result;
      }
      break;
  }
}
```

### 3. Understand the event shapes

| Event | Key fields | When it fires |
|-------|-----------|---------------|
| `tool_start` | `toolCallId`, `toolName`, `args` | Tool execution begins |
| `tool_progress` | `toolName`, `message`, `percent?`, `audience` | Mid-execution status update |
| `tool_end` | `toolCallId`, `toolName`, `ok`, `durationMs`, `result?` | Tool execution completes |

`tool_progress` events have an `audience` field: `'internal'`, `'user'`, or `'dashboard'`. Filter by audience to control what your dashboard surfaces:

```typescript
case 'tool_progress':
  if (event.audience === 'internal') break; // skip framework-internal progress
  // render user-facing and dashboard-facing progress
  break;
```

### 4. Render tool cards in React

```typescript
function ToolCard({ card }: { card: ToolCard }) {
  return (
    <div className="rounded border px-3 py-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs">{card.toolName}</span>
        <span className={
          card.status === 'running' ? 'text-yellow-500' :
          card.status === 'completed' ? 'text-green-600' :
          'text-red-500'
        }>
          {card.status}
        </span>
      </div>

      {card.progress && (
        <p className="mt-1 text-xs text-gray-500">{card.progress}</p>
      )}

      {card.percent !== undefined && (
        <div className="mt-1 h-1 rounded bg-gray-200">
          <div
            className="h-1 rounded bg-blue-500"
            style={{ width: `${card.percent}%` }}
          />
        </div>
      )}

      {card.durationMs !== undefined && (
        <p className="mt-1 text-xs text-gray-400">{card.durationMs}ms</p>
      )}
    </div>
  );
}
```

### 5. Clean up on unmount

In a React component, close the subscription when the component unmounts or the session changes:

```typescript
useEffect(() => {
  if (!sessionId) return;

  const sub = EventStream({
    baseUrl: ethos.baseUrl,
    apiKey,
    sessionId,
    onEvent: handleEvent,
    onError: console.error,
  });

  return () => sub.close();
}, [sessionId]);
```

The `EventStream` function returns an `EventStreamSubscription` with `close()`, `lastSeq`, and `closed` properties. Always close the subscription to avoid leaked connections.

## Verify

Trigger a turn that runs at least one tool — ask the agent to read a file, list directory contents, or fetch a URL. Tool cards appear in the order the tools execute, transition from `running` to `completed` or `failed`, and show `durationMs` on completion. Disconnect the network briefly: on reconnect, `EventStream` resumes from `lastSeq` and no events are duplicated.
