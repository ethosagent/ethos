# @ethosagent/sdk

Typed TypeScript client for the Ethos control-plane API. Provides RPC calls validated against the shared contract and an SSE streaming client for real-time agent events.

## Install

```bash
pnpm add @ethosagent/sdk
```

## Quick start

```typescript
import { EthosClient, EventStream } from '@ethosagent/sdk';

// 1. Create a client
const client = new EthosClient({
  baseUrl: 'http://localhost:2400',
  apiKey: 'esk_...', // from apiKeys.create
});

// 2. Send a message
const { sessionId, turnId } = await client.rpc.chat.send({
  clientId: 'my-app',
  text: 'What files are in the project?',
});

// 3. Stream the response
const sub = EventStream({
  baseUrl: 'http://localhost:2400',
  apiKey: 'esk_...',
  sessionId,
  onEvent(event, seq) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.text);
        break;
      case 'tool_start':
        console.log(`\n[tool] ${event.toolName}`);
        break;
      case 'done':
        console.log('\n--- done ---');
        sub.close();
        break;
    }
  },
});
```

## EthosClient

### Constructor

```typescript
const client = new EthosClient(options: EthosClientOptions);
```

| Option | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `string` | yes | Ethos web-api server origin (e.g. `http://localhost:2400`). |
| `apiKey` | `string` | no | Bearer token. Omit for cookie-auth mode. |
| `fetch` | `typeof fetch` | no | Custom fetch implementation for testing or non-browser runtimes. |

### RPC usage

All contract namespaces are accessible via `client.rpc`:

```typescript
// Sessions
const { sessions, nextCursor } = await client.rpc.sessions.list({ limit: 20 });
const { session, messages } = await client.rpc.sessions.get({ id: 'ses_abc' });

// Chat
const { sessionId } = await client.rpc.chat.send({
  clientId: 'tab-1',
  text: 'Hello',
  personalityId: 'architect',
});
await client.rpc.chat.abort({ sessionId });

// Personalities
const { personalities } = await client.rpc.personalities.list();
const { personality, soulMd } = await client.rpc.personalities.get({ id: 'sage' });

// Memory
const { files } = await client.rpc.memory.list();
await client.rpc.memory.write({ store: 'memory', content: '# Updated context' });
```

### Stable namespaces

These follow semver. Breaking changes require a major version bump.

- **sessions** -- `list`, `get`, `fork`, `delete`, `update`
- **chat** -- `send`, `abort`
- **personalities** -- `list`, `get`, `characterSheet`, `create`, `update`, `delete`, `duplicate`, plus per-personality skill CRUD
- **memory** -- `list`, `get`, `write`
- **meta** -- `capabilities`

### Experimental namespaces

May change in any minor release. Pin your SDK version.

`tools`, `clarify`, `onboarding`, `config`, `cron`, `skills`, `evolver`, `mesh`, `plugins`, `platforms`, `batch`, `eval`, `kanban`, `apiKeys`

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

## Exports

```typescript
// Classes & functions
export { EthosClient, EventStream };

// Types
export type {
  EthosClientOptions,
  EventStreamOptions,
  EventStreamSubscription,
  Contract,
  SseEvent,
  ApiKeyScope,
  ApiKeyMetadata,
};
```

## Full documentation

See the [SDK client reference](https://ethos.dev/docs/building/reference/sdk-client) and [EventStream reference](https://ethos.dev/docs/building/reference/sdk-event-stream) for complete API documentation.
