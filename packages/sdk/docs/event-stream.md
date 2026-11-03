# EventStream and cookie auth

## EventStream

Opens an SSE connection to stream real-time events from a session.

```typescript
import { EventStream } from '@ethosagent/sdk';

const sub = EventStream({
  baseUrl: 'http://localhost:2400',
  apiKey: 'esk_...',
  sessionId: 'ses_abc123',
  sinceSeq: 0,           // optional: resume from sequence
  signal: controller.signal, // optional: external abort
  onEvent(event, seq) {
    // event.type is the discriminator
  },
  onError(err) {
    console.error(err);
  },
});

console.log(sub.lastSeq);  // last processed sequence number
console.log(sub.closed);   // true after close()
sub.close();               // stop the stream
```

Auto-reconnects with a 3-second delay. Resumes from the last sequence number so no events are lost.

### Event types

**Per-turn:** `text_delta`, `thinking_delta`, `tool_start`, `tool_progress`, `tool_end`, `usage`, `context_meta`, `done`, `error`, `message_persisted`

**Push (system-wide):** `tool.approval_required`, `approval.resolved`, `clarify.request`, `clarify.resolved`, `cron.fired`, `mesh.changed`, `evolve.skill_pending`, `protocol.upgrade_required`

## Cookie-auth mode

Omit `apiKey` to use browser session cookies instead of a bearer token. Requests are sent with `credentials: 'include'`.

```typescript
// In a browser context where the user is already logged in
const client = new EthosClient({ baseUrl: 'http://localhost:2400' });
```

Cookie-auth is required for the `apiKeys` admin namespace (creating, listing, and revoking API keys). Bearer tokens cannot access this namespace to prevent privilege escalation.

