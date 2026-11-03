---
title: "Add a channel adapter, part 2: implement the adapter and wire it in"
description: "Write the adapter class, add the path alias and wire it into the gateway."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 4-5 of [Add a channel adapter](add-a-channel-adapter.md): Implement the adapter; Add a path alias.

## Prereqs

- Complete [part 1 of 4](add-a-channel-adapter.md).

## 4. Implement the adapter

Open `extensions/platform-stdio/src/index.ts`. The skeleton has six methods — `start`, `stop`, `send`, `onMessage`, `health`, and a constructor — plus seven readonly capability flags.

```typescript
import { createInterface, type Interface } from 'node:readline';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';

export interface StdioAdapterConfig {
  /** Stable id for this terminal — becomes the session key. Default: hostname. */
  chatId?: string;
  /** Username surfaced in InboundMessage. Default: $USER. */
  username?: string;
}

export class StdioAdapter implements PlatformAdapter {
  readonly id = 'stdio';
  readonly displayName = 'Stdio';

  // Capability flags. The gateway reads these to decide which surface
  // affordances to use. Conservative defaults — say no when in doubt.
  readonly canSendTyping = false;
  readonly canEditMessage = false;
  readonly canReact = false;
  readonly canSendFiles = false;
  readonly maxMessageLength = 100_000; // stdout has no real limit

  private readonly chatId: string;
  private readonly username: string;

  private rl?: Interface;
  private messageHandler?: (message: InboundMessage) => void;
  private messageCounter = 0;
  private startedAt = 0;

  constructor(config: StdioAdapterConfig = {}) {
    this.chatId = config.chatId ?? `stdio:${process.env.HOSTNAME ?? 'local'}`;
    this.username = config.username ?? process.env.USER ?? 'user';
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

    this.rl.on('line', (line) => {
      const text = line.trim();
      if (text.length === 0) return;
      if (!this.messageHandler) return;

      this.messageCounter += 1;
      const msg: InboundMessage = {
        platform: 'stdio',
        chatId: this.chatId,
        userId: this.username,
        username: this.username,
        text,
        isDm: true,
        isGroupMention: false,
        // Set messageId so the gateway can dedupe if stdin somehow replays.
        // For real platforms (Telegram update_id, Slack ts) the inbound id is
        // load-bearing — use it.
        messageId: `${this.startedAt}:${this.messageCounter}`,
        raw: line,
      };

      this.messageHandler(msg);
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = undefined;
    this.messageHandler = undefined;
  }

  // -------------------------------------------------------------------------
  // Send / receive
  // -------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    // The gateway has already checked outboundDedup.shouldSend(sessionKey, text)
    // before invoking us. Do not re-dedupe here; that path is owned by
    // extensions/gateway/src/dedup.ts and clearSession-aware.
    if (chatId !== this.chatId) {
      return { ok: false, error: `unknown chatId: ${chatId}` };
    }
    process.stdout.write(`\n${message.text}\n\n> `);
    return { ok: true, messageId: `out:${Date.now()}` };
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async health(): Promise<{ ok: boolean; latencyMs?: number }> {
    return { ok: this.rl !== undefined, latencyMs: 0 };
  }
}
```

Walk through it once before moving on:

- **`onMessage` stores a single handler.** The gateway calls this once during boot. The platform delivers an event → the adapter normalises it into `InboundMessage` → the handler runs. The adapter does not know what happens next; the gateway routes to the right session lane and runs `AgentLoop`.
- **`messageId` is a stable id from the platform.** For stdio, terminal lines are not retried, but we set one anyway so the inbound dedup logic in the gateway has something to key on. For Telegram, use `ctx.update.update_id`; for Slack, the message `ts`; for Discord, the message id.
- **`send` writes to stdout and returns `DeliveryResult`.** The return shape is `{ ok: true, messageId? }` on success or `{ ok: false, error }` on failure. The gateway logs failures and may retry — return real errors here, do not swallow them.
- **Capability flags lean conservative.** `canEditMessage: false` means the gateway will not call `editMessage` and will not stream partial replies as in-place edits. `canSendTyping: false` skips the typing indicator. The flags are advertisement; the gateway adapts.
- **No dedup logic anywhere.** The `chatId` check in `send` is a sanity assertion (we should never be asked to send to a different terminal), not a dedup gate.

`start`'s job is to open the connection (stdin in our case, a long poll for Telegram, a websocket for Discord); `stop`'s job is to release it. Both are async because real platforms need to await — keep the contract async even when your implementation is synchronous.

## 5. Add a path alias

Open the root `tsconfig.json` (or `tsconfig.base.json`) and add the alias:

```json
{
  "compilerOptions": {
    "paths": {
      "@ethosagent/platform-stdio": ["./extensions/platform-stdio/src"]
    }
  }
}
```

Without the alias, the wiring import resolves to `node_modules` and `pnpm typecheck` fails.

## What you learned

- Steps 4-5 done: Implement the adapter; Add a path alias.

## Next step

Continue with [part 3 of 4: configure, run and test the adapter](add-a-channel-adapter-3-config-and-test.md).
