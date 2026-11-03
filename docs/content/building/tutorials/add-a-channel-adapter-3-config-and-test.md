---
title: "Add a channel adapter, part 3: configure, run and test the adapter"
description: "Update the config, run the adapter and test it in isolation."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 6-8 of [Add a channel adapter](add-a-channel-adapter.md): Wire it into the gateway; Update the config and run it; Test the adapter in isolation.

## Prereqs

- Complete [part 2 of 4](add-a-channel-adapter-2-implement-and-wire.md).

## 6. Wire it into the gateway

Channel-adapter selection lives in `apps/ethos/src/commands/gateway.ts`. Find the section where the existing adapters are constructed — there is a branch on the user's configured `channels:` list that instantiates `TelegramAdapter`, `DiscordAdapter`, `SlackAdapter`. Add a fourth branch:

```typescript
import { StdioAdapter } from '@ethosagent/platform-stdio';
// ... existing imports ...

const adapters: PlatformAdapter[] = [];

if (config.channels?.includes('telegram') && config.telegramToken) {
  adapters.push(new TelegramAdapter({ token: config.telegramToken }));
}
if (config.channels?.includes('discord') && config.discordToken) {
  adapters.push(new DiscordAdapter({ token: config.discordToken }));
}
if (config.channels?.includes('slack') && config.slackToken) {
  adapters.push(new SlackAdapter({ token: config.slackToken }));
}
// New:
if (config.channels?.includes('stdio')) {
  adapters.push(new StdioAdapter());
}

// ... existing gateway construction passes `adapters` ...
```

The exact location and helper names vary as the file evolves — the load-bearing piece is that you construct your adapter and add it to the list the gateway iterates over. The gateway calls `adapter.onMessage(handler)` per adapter; from there, every inbound is routed through the same code path.

For the existing `Gateway` class signature, see `extensions/gateway/src/index.ts`. It accepts an `adapters: PlatformAdapter[]` array in its constructor and binds the handler to each one. You do not modify the gateway itself.

## 7. Update the config and run it

Edit `~/.ethos/config.yaml`:

```yaml
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-...
channels:
  - stdio
```

Start the gateway in the foreground:

```bash
ethos gateway start
```

Expected boot:

```
ethos gateway  starting...
✓ Stdio adapter ready (id: stdio:hostname)
Listening for messages. Press Ctrl+C to stop.
```

Type:

```
hello there
```

The agent processes the line, runs `AgentLoop` against the active personality, and your adapter's `send()` writes the streamed final reply to stdout. The dev loop is identical to `pnpm dev` chat — same `AgentLoop`, same providers, same tools, same hooks. The only thing different is the surface.

## 8. Test the adapter in isolation

Adapters are testable without spinning up `AgentLoop`. The pattern: instantiate the adapter, register an `onMessage` handler that captures, feed it an event, assert what `send` produces.

Create `extensions/platform-stdio/src/__tests__/stdio.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { InboundMessage } from '@ethosagent/types';
import { StdioAdapter } from '..';

describe('StdioAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits an InboundMessage for each line typed', async () => {
    // Replace process.stdin with a controlled stream so we can drive input.
    const input = new Readable({ read() {} });
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });

    const adapter = new StdioAdapter({ chatId: 'test:terminal', username: 'tester' });
    const received: InboundMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));

    await adapter.start();

    input.push('hello\n');
    input.push('  \n');           // whitespace-only is ignored
    input.push('second line\n');
    // Give the readline interface a microtask to emit.
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      platform: 'stdio',
      chatId: 'test:terminal',
      username: 'tester',
      text: 'hello',
      isDm: true,
      isGroupMention: false,
    });
    expect(received[0].messageId).toMatch(/^\d+:1$/);
    expect(received[1].text).toBe('second line');

    await adapter.stop();
  });

  it('writes outbound text to stdout', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const adapter = new StdioAdapter({ chatId: 'test:terminal' });
    await adapter.start();

    const result = await adapter.send('test:terminal', { text: 'Hello back.' });

    expect(result.ok).toBe(true);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Hello back.'));

    await adapter.stop();
  });

  it('rejects sends to an unknown chatId', async () => {
    const adapter = new StdioAdapter({ chatId: 'test:terminal' });
    await adapter.start();

    const result = await adapter.send('other:terminal', { text: 'wrong room' });
    expect(result).toMatchObject({ ok: false });
    await adapter.stop();
  });
});
```

Run:

```bash
pnpm --filter @ethosagent/platform-stdio test
```

Three passes. None of these tests instantiate `AgentLoop`, the gateway, or a provider — the adapter's contract is unit-testable on its own. The production adapters under `extensions/platform-telegram/src/__tests__/` follow the same pattern, with the platform client mocked at the SDK boundary.

## What you learned

- Steps 6-8 done: Wire it into the gateway; Update the config and run it; Test the adapter in isolation.

## Next step

Continue with [part 4 of 4: session keys, streaming, voice, access](add-a-channel-adapter-4-sessions-streaming-voice.md).
