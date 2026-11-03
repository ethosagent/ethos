# sdk quick start

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

