import type { SSEStreamingApi } from 'hono/streaming';

// Idle-connection keep-alive, shared by every `/sse/*` route (`sse.ts`,
// `kanban-sse.ts`, `goal-sse.ts`) — an SSE *comment* line (leading `:`), not
// a `data:` frame, so it never advances a client's `Last-Event-ID` cursor or
// reaches an app's event handler. Without it a held-open stream that has
// nothing new to say looks identical, to a proxy or to the SDK's own stall
// watchdog (`packages/sdk/src/stream.ts`), to one that died silently.
// `system-sse.ts` already pings its own way (a real `ping` data frame) and
// is left alone. Pinned by
// `apps/web-api/src/__tests__/routes/sse-heartbeat.test.ts`.
export const HEARTBEAT_MS = 15_000;

export function startHeartbeat(stream: SSEStreamingApi, ms = HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    void stream.write(': hb\n\n');
  }, ms);
  return () => clearInterval(timer);
}
