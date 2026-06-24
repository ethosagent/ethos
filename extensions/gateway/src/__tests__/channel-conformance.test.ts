import type { AgentLoop } from '@ethosagent/core';
import { deriveBotKey } from '@ethosagent/core';
import type {
  ChannelContext,
  InboundMessage,
  PlatformAdapter,
  PlatformAdapterFactory,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

// ---------------------------------------------------------------------------
// Minimal stubs (matches existing test patterns in plugin-adapter.test.ts)
// ---------------------------------------------------------------------------

function stubAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
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
    ...overrides,
  };
}

function stubLoop(overrides: Record<string, unknown> = {}) {
  return {
    run: vi.fn(async function* () {
      yield { type: 'text_delta' as const, text: 'reply' };
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    hooks: {
      registerVoid: vi.fn().mockReturnValue(() => {}),
    },
    ...overrides,
  };
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'test-plugin',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'hello from plugin adapter',
    isDm: true,
    isGroupMention: false,
    messageId: 'msg-1',
    raw: {},
    ...overrides,
  };
}

function makeBots(loop: ReturnType<typeof stubLoop>, botKey?: string) {
  return [
    {
      botKey: botKey ?? deriveBotKey('my-channel'),
      loop: loop as unknown as AgentLoop,
      binding: { type: 'personality' as const, name: 'default' },
    },
  ];
}

describe('Channel SDK conformance (§4.A)', () => {
  it('plugin adapter routes inbound → lane → agent loop → dedup → outbound with zero core edits', async () => {
    // 1. Create a plugin adapter (simulating a re-homed built-in like Telegram)
    let capturedCtx: ChannelContext | undefined;
    const pluginAdapter = stubAdapter({
      id: 'rehomed-telegram',
      startWithContext: vi.fn().mockImplementation(async (ctx: ChannelContext) => {
        capturedCtx = ctx;
      }),
    });
    const factory: PlatformAdapterFactory = vi.fn(() => pluginAdapter);

    // 2. Pass it as pluginAdapters to new Gateway()
    const botKey = deriveBotKey('rehomed-telegram');
    const loop = stubLoop();
    const _gw = new Gateway({
      bots: [
        {
          botKey,
          loop: loop as unknown as AgentLoop,
          binding: { type: 'personality' as const, name: 'default' },
        },
      ],
      pluginAdapters: new Map([['rehomed-telegram', factory]]),
      clarifySweepIntervalMs: 0,
    });

    expect(capturedCtx).toBeDefined();

    // 3. Simulate an inbound message via the ChannelContext.onMessage callback
    const msg = makeMessage({ platform: 'rehomed-telegram', botKey: undefined });
    await capturedCtx?.onMessage(msg);

    // 4. Assert the agent loop received the message
    expect(loop.run).toHaveBeenCalledTimes(1);

    // 5. Assert outbound response went through adapter.send (dedup passes on first send)
    expect(pluginAdapter.send).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ text: 'reply' }),
    );
  });

  it('trustedChannelPlugins gates plugin adapter startup', () => {
    // 1. Create a plugin adapter
    const pluginAdapter = stubAdapter({ id: 'gated-channel' });
    const factory: PlatformAdapterFactory = vi.fn(() => pluginAdapter);

    // 2. Pass trustedChannelPlugins that does NOT include it
    const loop = stubLoop();
    new Gateway({
      bots: makeBots(loop),
      pluginAdapters: new Map([['gated-channel', factory]]),
      trustedChannelPlugins: new Set(['other-plugin']),
      clarifySweepIntervalMs: 0,
    });

    // 3. Assert the factory was never called
    expect(factory).not.toHaveBeenCalled();
    // Adapter was never started — it should not be in the adapter registry
    // (verified indirectly: sendTo would fail because no adapter is registered)
  });

  it('botKey fallback routes to default bot when botKey is unknown', async () => {
    // 1. Set up gateway with a default bot
    let capturedCtx: ChannelContext | undefined;
    const pluginAdapter = stubAdapter({
      id: 'fallback-channel',
      startWithContext: vi.fn().mockImplementation(async (ctx: ChannelContext) => {
        capturedCtx = ctx;
      }),
    });
    const factory: PlatformAdapterFactory = vi.fn(() => pluginAdapter);

    const defaultBotKey = deriveBotKey('fallback-channel');
    const loop = stubLoop();
    new Gateway({
      bots: [
        {
          botKey: defaultBotKey,
          loop: loop as unknown as AgentLoop,
          binding: { type: 'personality' as const, name: 'default' },
        },
      ],
      pluginAdapters: new Map([['fallback-channel', factory]]),
      clarifySweepIntervalMs: 0,
    });

    expect(capturedCtx).toBeDefined();

    // 2. Send a message with an unknown botKey
    const msg = makeMessage({
      platform: 'fallback-channel',
      botKey: 'nonexistent-bot-key',
    });
    await capturedCtx?.onMessage(msg);

    // 3. Assert it routes to the default bot (not dropped)
    expect(loop.run).toHaveBeenCalledTimes(1);
    expect(pluginAdapter.send).toHaveBeenCalled();
  });
});
