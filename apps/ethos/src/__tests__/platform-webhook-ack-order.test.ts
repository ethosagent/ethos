// Inbound spool ack ordering (plan reach-and-containment §2.5, D2-10).
//
// The platform webhook server never sees an InboundMessage: grammy / Bolt parse
// the body inside the handler, call the adapter's message callback, and answer
// 200 once the handler returns. So the ordering that matters is: the spool row
// must exist by the time the adapter's callback RETURNS. This drives a real
// `createPlatformWebhookServer`, a handler shaped like grammy's (parse → call
// back → ack), and the real `wireAdapterInbound` wiring into a real Gateway.

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentLoop } from '@ethosagent/core';
import { Gateway } from '@ethosagent/gateway';
import { SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireAdapterInbound } from '../commands/gateway';
import { createPlatformWebhookServer } from '../platform-webhook-server';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe('platform webhook ack ordering', () => {
  it('the spool row is on disk before the webhook is acknowledged', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    let callback: ((m: InboundMessage) => void) | undefined;
    const adapter = {
      id: 'telegram:bot-a',
      displayName: 'Telegram',
      canSendTyping: false,
      canEditMessage: false,
      canReact: false,
      canSendFiles: false,
      maxMessageLength: 4096,
      start: vi.fn(),
      stop: vi.fn(),
      send: vi.fn().mockResolvedValue({ ok: true, messageId: '1' }),
      onMessage: (h: (m: InboundMessage) => void) => {
        callback = h;
      },
      health: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as PlatformAdapter;
    const loop = {
      run: vi.fn(async function* () {
        await new Promise(() => {}); // the turn never matters here
      }),
      hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    };
    const gateway = new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: loop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'p' },
        },
      ],
      adapters: new Map([['telegram', adapter]]),
      inboundSpool: spool,
      inboundSpoolOptions: { replayIntervalMs: 0 },
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });
    wireAdapterInbound(gateway, adapter);

    let receivedAtAck = -1;
    // grammy's shape: read the body, run middleware (the adapter callback),
    // THEN answer. Nothing awaits between the callback and the 200.
    const grammyLike = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const update = JSON.parse(Buffer.concat(chunks).toString()) as { text: string; id: string };
      callback?.({
        platform: 'telegram',
        chatId: 'chat-1',
        userId: 'user-1',
        text: update.text,
        isDm: true,
        isGroupMention: false,
        botKey: 'bot-a',
        messageId: update.id,
        raw: update,
      });
      receivedAtAck = spool.stats().received + spool.stats().processing;
      res.writeHead(200);
      res.end();
    };
    server = createPlatformWebhookServer({
      port: 0,
      host: '127.0.0.1',
      telegram: new Map([['bot-a', grammyLike]]),
    });
    await new Promise<void>((r) => server?.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/telegram/webhook/bot-a`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hello', id: 'u-1' }),
    });
    expect(res.status).toBe(200);
    expect(receivedAtAck).toBe(1);
    await gateway.shutdown({ drainTimeoutMs: 50 });
  });
});
