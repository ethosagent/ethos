import { type AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

// Context-economy Phase 1 — the `gateway_message` claiming hook fires after
// bot/lane resolution but before any agent turn is enqueued. A claiming
// handler answers deterministically (zero LLM tokens); no handler → behavior
// unchanged. Replies flow through the same outbound dedup gate as turn
// replies.

function stubAdapter(): PlatformAdapter {
  return {
    id: 'test',
    displayName: 'Test',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ ok: true, messageId: '1' }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

// A stub loop carrying a REAL hook registry, so the gateway exercises the
// genuine fireClaiming first-handled-wins semantics.
function stubLoop() {
  return {
    run: vi.fn(async function* () {
      yield { type: 'text_delta' as const, text: 'agent reply' };
      yield { type: 'done' as const, text: 'agent reply', turnCount: 1 };
    }),
    hooks: new DefaultHookRegistry(),
  };
}

function makeMessage(text: string, messageId = '1'): InboundMessage {
  return {
    platform: 'telegram',
    chatId: '100',
    userId: '200',
    text,
    isDm: true,
    isGroupMention: false,
    messageId,
    botKey: 'test-bot',
    raw: {},
  };
}

function makeGateway(loop: ReturnType<typeof stubLoop>) {
  return new Gateway({
    bots: [
      {
        botKey: 'test-bot',
        loop: loop as unknown as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    clarifySweepIntervalMs: 0,
  });
}

describe('Gateway — gateway_message claiming hook', () => {
  it('a claiming handler answers without an agent turn; the reply is sent once', async () => {
    const loop = stubLoop();
    loop.hooks.registerClaiming('gateway_message', async (payload) => {
      if (payload.text === '/ping') return { handled: true, reply: 'pong' };
      return { handled: false };
    });
    const gw = makeGateway(loop);
    const adapter = stubAdapter();

    await gw.handleMessage(makeMessage('/ping'), adapter);

    expect(loop.run).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledTimes(1);
    const reply = vi.mocked(adapter.send).mock.calls[0]?.[1] as { text: string };
    expect(reply.text).toBe('pong');
  });

  it('a second identical reply within the dedup TTL is suppressed', async () => {
    const loop = stubLoop();
    loop.hooks.registerClaiming('gateway_message', async () => ({
      handled: true,
      reply: 'pong',
    }));
    const gw = makeGateway(loop);
    const adapter = stubAdapter();

    // Distinct messageIds so inbound dedup does not intercept first.
    await gw.handleMessage(makeMessage('/ping', 'a'), adapter);
    await gw.handleMessage(makeMessage('/ping', 'b'), adapter);

    expect(loop.run).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it('handled without a reply sends nothing and starts no turn', async () => {
    const loop = stubLoop();
    loop.hooks.registerClaiming('gateway_message', async () => ({ handled: true }));
    const gw = makeGateway(loop);
    const adapter = stubAdapter();

    await gw.handleMessage(makeMessage('silent'), adapter);

    expect(loop.run).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('an unclaimed message proceeds to the agent turn', async () => {
    const loop = stubLoop();
    loop.hooks.registerClaiming('gateway_message', async () => ({ handled: false }));
    const gw = makeGateway(loop);
    const adapter = stubAdapter();

    await gw.handleMessage(makeMessage('hello'), adapter);

    expect(loop.run).toHaveBeenCalledTimes(1);
  });

  it('no handler registered → turn proceeds exactly as before', async () => {
    const loop = stubLoop();
    const gw = makeGateway(loop);
    const adapter = stubAdapter();

    await gw.handleMessage(makeMessage('hello'), adapter);

    expect(loop.run).toHaveBeenCalledTimes(1);
    const reply = vi.mocked(adapter.send).mock.calls[0]?.[1] as { text: string };
    expect(reply.text).toBe('agent reply');
  });

  it('the payload carries the resolved bot/lane identity', async () => {
    const loop = stubLoop();
    const seen: unknown[] = [];
    loop.hooks.registerClaiming('gateway_message', async (payload) => {
      seen.push(payload);
      return { handled: true };
    });
    const gw = makeGateway(loop);

    await gw.handleMessage(makeMessage('/status'), stubAdapter());

    expect(seen).toEqual([
      {
        platform: 'telegram',
        chatId: '100',
        botKey: 'test-bot',
        userId: '200',
        text: '/status',
        isDm: true,
      },
    ]);
  });
});
