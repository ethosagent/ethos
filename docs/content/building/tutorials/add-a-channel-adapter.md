---
title: "Add a channel adapter"
description: "Build a stdin/stdout PlatformAdapter — send/receive contract, lifecycle, why the gateway owns dedup, voice caps, wired in as the smallest new channel."
kind: tutorial
audience: developer
slug: add-a-channel-adapter
time: "25 min"
updated: 2026-11-03
---

A [channel adapter](../../getting-started/glossary.md#channel-adapter) bridges a messaging platform — Telegram, Discord, Slack, a webhook, a terminal pipe — to the agent. Inbound, the adapter normalises platform events into `InboundMessage`. Outbound, the adapter calls `send()` and the [gateway](../../getting-started/glossary.md#gateway) handles every cross-cutting concern around it (session lanes, dedup, typing indicators, safety filters).

This tutorial builds the smallest possible adapter: stdin/stdout. Each line you type is an inbound message; each `adapter.send()` writes a line to stdout. Once it works, the same shape — `start`, `stop`, `send`, `onMessage` — is what Telegram, Discord, and Slack implement against real APIs.

You ship it as `extensions/platform-stdio/`, wired into `runGatewayStart` alongside the existing channels.

## Goal

By the end, you have:

- `extensions/platform-stdio/src/index.ts` — a class implementing `PlatformAdapter` from `@ethosagent/types`.
- A working session keyed off a stable terminal id so `/new` and dedup behave correctly.
- A confident answer to "where do I put dedup logic?" — namely, nowhere: the gateway already handles it.
- The adapter wired into the gateway via `apps/ethos/src/commands/gateway.ts`, selectable as a channel under `~/.ethos/config.yaml`.
- Tests that exercise `onMessage` / `send` in isolation without spinning up `AgentLoop`.

The stdio adapter is intentionally a toy. The contract it implements is exactly what every production adapter implements; once the shape is in your head, the work of bringing up a new platform is mostly translation, not design.

## Prereqs

- [Build on Ethos in ten minutes](../quickstart.md) finished — `pnpm dev` runs a chat against your local tree.
- [Write your first tool](./write-your-first-tool.md) helpful but not required — the dev loop is the same.
- A read of `packages/types/src/platform.ts` (60 lines). The interfaces in this tutorial come from there verbatim.
- A skim of `extensions/platform-telegram/src/index.ts`. It is the production adapter closest in shape to what you are about to write — a single class, `start` opens a long poll, `send` writes back.

## Parts

| Part | Covers |
|---|---|
| 1. Add a channel adapter (this page) | Steps 1-3: Read the contract, Understand the dedup boundary before you write code, Create the extension package |
| [2. Implement the adapter and wire it in](add-a-channel-adapter-2-implement-and-wire.md) | Steps 4-5: Implement the adapter, Add a path alias |
| [3. Configure, run and test the adapter](add-a-channel-adapter-3-config-and-test.md) | Steps 6-8: Wire it into the gateway, Update the config and run it, Test the adapter in isolation |
| [4. Session keys, streaming, voice, access](add-a-channel-adapter-4-sessions-streaming-voice.md) | Steps 9-12: Session-key implications, Streaming reply patterns, Opt in to spoken replies, Channel filtering and access control |

## 1. Read the contract

`packages/types/src/platform.ts` declares everything. The interface you implement and the message types you produce:

```typescript
export interface PlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly canSendTyping: boolean;
  readonly canEditMessage: boolean;
  readonly canReact: boolean;
  readonly canSendFiles: boolean;
  readonly maxMessageLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, message: OutboundMessage): Promise<DeliveryResult>;
  sendTyping?(chatId: string): Promise<void>;
  editMessage?(chatId: string, messageId: string, text: string): Promise<DeliveryResult>;
  onMessage(handler: (message: InboundMessage) => void): void;
  health(): Promise<{ ok: boolean; latencyMs?: number }>;
}

export interface InboundMessage {
  platform: string;
  chatId: string;
  userId?: string;
  username?: string;
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  replyToUserId?: string;
  isDm: boolean;
  isGroupMention: boolean;
  messageId?: string;
  raw: unknown;
}

export interface OutboundMessage {
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  parseMode?: 'markdown' | 'html' | 'plain';
}
```

Three rules that fall out of the contract:

- **One handler per adapter.** `onMessage` registers a single callback; calling it twice replaces the first. The gateway is the handler — it routes the message to the right session, runs the agent, and calls `send` with the reply. You do not call `AgentLoop` from inside the adapter.
- **Capability booleans are advertised, not negotiated.** `canSendTyping` etc. tell the gateway what the platform supports. The gateway uses them to decide whether to emit typing indicators, edit messages in place, etc. A `false` here is fine — the gateway skips that surface affordance.
- **`raw` carries the platform-native payload.** Anything you cannot model in the normalised fields — Telegram entities, Discord embed metadata, Slack thread timestamps — goes here untyped so consumers that care can downcast. Most consumers ignore it.

The `id` field is the discriminator the gateway routes on (`telegram`, `discord`, `slack`, `stdio`). It must match the string used in inbound `message.platform` so session keys remain consistent.

## 2. Understand the dedup boundary before you write code

The single most common mistake in writing a new adapter is rolling your own outbound deduplication. **Do not.** The gateway already does it.

The gateway holds a `MessageDedupCache` in `extensions/gateway/src/dedup.ts` keyed by `(sessionId, sha256(content))` with a 30-second TTL; on a reply the key also carries the inbound message it answers (`cache.shouldSend(sessionKey, content, scope)`, `replyDedupScope`). Every outbound send routes through `cache.shouldSend` first. Same content within the TTL on the same session (and, for a reply, the same inbound message) is silently dropped. This means:

- A poll-reconnect that delivers the same inbound twice produces two `loop.run()` invocations — the second one's identical streamed reply is dropped at the cache boundary.
- An adapter that retries `send` on transient failure ends up double-sending the same content; the cache absorbs it.
- A session boundary (`/new`, `/personality`) clears the cache for that session so the same reply text can be sent again under the fresh session key.

If you find yourself writing `if (this.lastSentText !== text)` inside your adapter, stop. That is the cache's job. The gateway already routed the call through `cache.shouldSend` before invoking `adapter.send`. See [gateway dedup explanation](../../building/explanation/audience-boundary.md) for the design rationale and `extensions/gateway/src/__tests__/dedup.test.ts` for the cases that drive the TTL.

The configuration knobs are at the gateway level: `GatewayConfig.outboundDedupTtlMs` (default 30,000) (`0` disables it). Nothing in the adapter touches these.

The inbound side is different and adapter-local. If your platform delivers duplicate inbounds (webhook retries, polling overlap), set `InboundMessage.messageId` to a stable platform-native id; the gateway dedupes the inbound on `(platform, chatId, messageId)` and silently drops duplicates. The stdio adapter does not need this — terminal lines are not retried.

## 3. Create the extension package

```bash
mkdir -p extensions/platform-stdio/src/__tests__
cd extensions/platform-stdio
```

Write `package.json`:

```json
{
  "name": "@ethosagent/platform-stdio",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "production": "./dist/index.js"
    }
  },
  "dependencies": {
    "@ethosagent/types": "workspace:*"
  }
}
```

No runtime deps beyond `@ethosagent/types`. The adapter uses `process.stdin` and `process.stdout` directly — the same is true of every production adapter, give or take a `grammy` or `discord.js` for the upstream connection.

Run install from the repo root:

```bash
cd ../../
pnpm install
```

## What you learned

- Steps 1-3 done: Read the contract; Understand the dedup boundary before you write code; Create the extension package.

## Next step

Continue with [part 2 of 4: implement the adapter and wire it in](add-a-channel-adapter-2-implement-and-wire.md).
