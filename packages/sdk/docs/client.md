# EthosClient

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

// Paged history: newest turns first, then walk back with the cursor.
// Skip the full transcript on `get` when you page instead.
const { session: meta } = await client.rpc.sessions.get({ id: 'ses_abc', withMessages: false });
let page = await client.rpc.sessions.messages({ id: meta.id, turns: 20 });
while (page.nextCursor) {
  page = await client.rpc.sessions.messages({ id: meta.id, before: page.nextCursor });
}

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

- **sessions** -- `list`, `get`, `messages`, `fork`, `delete`, `update`
- **chat** -- `send`, `abort`
- **personalities** -- `list`, `get`, `characterSheet`, `create`, `update`, `delete`, `duplicate`, plus per-personality skill CRUD
- **memory** -- `list`, `get`, `write`
- **meta** -- `capabilities`

### Experimental namespaces

May change in any minor release. Pin your SDK version.

`tools`, `clarify`, `onboarding`, `config`, `cron`, `skills`, `evolver`, `mesh`, `plugins`, `platforms`, `batch`, `eval`, `kanban`, `apiKeys`

