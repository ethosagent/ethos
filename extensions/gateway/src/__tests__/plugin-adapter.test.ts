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
// Minimal stubs (matches existing test patterns)
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
      botKey: botKey ?? deriveBotKey('test-plugin/my-channel'),
      loop: loop as unknown as AgentLoop,
      binding: { type: 'personality' as const, name: 'default' },
    },
  ];
}

describe('Gateway — plugin-contributed adapters (Channel SDK)', () => {
  it('calls factory, starts adapter with context, and registers for outbound sends', async () => {
    const pluginAdapter = stubAdapter({
      id: 'my-channel',
      startWithContext: vi.fn().mockResolvedValue(undefined),
    });
    const factory: PlatformAdapterFactory = vi.fn(() => pluginAdapter);

    const loop = stubLoop();
    const gw = new Gateway({
      bots: makeBots(loop),
      pluginAdapters: new Map([['test-plugin/my-channel', factory]]),
      clarifySweepIntervalMs: 0,
    });

    // Factory was called
    expect(factory).toHaveBeenCalledWith({});
    // startWithContext was called (not start)
    expect(pluginAdapter.startWithContext).toHaveBeenCalledTimes(1);
    expect(pluginAdapter.start).not.toHaveBeenCalled();

    // Adapter registered for outbound sends
    const result = await gw.sendTo('test-plugin/my-channel', 'some-chat', 'hello');
    expect(result.ok).toBe(true);
    expect(pluginAdapter.send).toHaveBeenCalledWith(
      'some-chat',
      expect.objectContaining({ text: 'hello' }),
    );
  });

  it('falls back to start() when startWithContext is absent', () => {
    const pluginAdapter = stubAdapter({ id: 'legacy-channel' });
    const factory: PlatformAdapterFactory = vi.fn(() => pluginAdapter);

    const loop = stubLoop();
    new Gateway({
      bots: makeBots(loop),
      pluginAdapters: new Map([['test-plugin/legacy-channel', factory]]),
      clarifySweepIntervalMs: 0,
    });

    expect(pluginAdapter.start).toHaveBeenCalledTimes(1);
  });

  it('ChannelContext.onMessage auto-stamps botKey on inbound messages', async () => {
    let capturedCtx: ChannelContext | undefined;
    const pluginAdapter = stubAdapter({
      id: 'my-channel',
      startWithContext: vi.fn().mockImplementation(async (ctx: ChannelContext) => {
        capturedCtx = ctx;
      }),
    });
    const factory: PlatformAdapterFactory = vi.fn(() => pluginAdapter);

    const botKey = deriveBotKey('test-plugin/my-channel');
    const loop = stubLoop();
    new Gateway({
      bots: [
        {
          botKey,
          loop: loop as unknown as AgentLoop,
          binding: { type: 'personality' as const, name: 'default' },
        },
      ],
      pluginAdapters: new Map([['test-plugin/my-channel', factory]]),
      clarifySweepIntervalMs: 0,
    });

    // startWithContext should have captured the context
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.botKey).toBe(botKey);

    // Simulate adapter sending an inbound message WITHOUT botKey
    const msg = makeMessage({ botKey: undefined });
    await capturedCtx?.onMessage(msg);

    // The loop should have been called (message routed through handleMessage)
    expect(loop.run).toHaveBeenCalledTimes(1);
  });

  it('ChannelContext.onMessage pins botKey to the adapter, overriding a foreign botKey', async () => {
    let capturedCtx: ChannelContext | undefined;
    const pluginAdapter = stubAdapter({
      id: 'my-channel',
      startWithContext: vi.fn().mockImplementation(async (ctx: ChannelContext) => {
        capturedCtx = ctx;
      }),
    });
    const factory: PlatformAdapterFactory = vi.fn(() => pluginAdapter);

    // Two bots: the plugin adapter's own bot, and a foreign bot the adapter
    // must NOT be able to address. GWA-002: a plugin adapter represents
    // exactly one bot, so a caller-supplied botKey is pinned back to the
    // adapter's derived key and can never route into another bot's loop.
    const adapterBotKey = deriveBotKey('test-plugin/my-channel');
    const foreignBotKey = 'foreign-bot';
    const adapterLoop = stubLoop();
    const foreignLoop = stubLoop();
    new Gateway({
      bots: [
        {
          botKey: adapterBotKey,
          loop: adapterLoop as unknown as AgentLoop,
          binding: { type: 'personality' as const, name: 'default' },
        },
        {
          botKey: foreignBotKey,
          loop: foreignLoop as unknown as AgentLoop,
          binding: { type: 'personality' as const, name: 'other' },
        },
      ],
      pluginAdapters: new Map([['test-plugin/my-channel', factory]]),
      clarifySweepIntervalMs: 0,
    });

    expect(capturedCtx).toBeDefined();

    // Message carries the FOREIGN botKey — the gateway must re-stamp it.
    const msg = makeMessage({ botKey: foreignBotKey });
    await capturedCtx?.onMessage(msg);

    // Routed to the adapter's own loop, never the foreign one.
    expect(adapterLoop.run).toHaveBeenCalledTimes(1);
    expect(foreignLoop.run).not.toHaveBeenCalled();
  });

  it('adapter with caps.edit === false gets graceful degradation', () => {
    const pluginAdapter = stubAdapter({
      id: 'no-edit',
      caps: {
        media: { imagesIn: false, filesIn: false, imagesOut: false, filesOut: false },
        voice: { transcribeIn: false, ttsOut: false },
        threads: false,
        reactions: { in: false, out: false },
        edit: false,
        delete: false,
        typing: false,
        readReceipts: false,
        approvalButtons: false,
        slashCommands: false,
        mentions: false,
        ephemeral: false,
        multiAccount: false,
        contractVersion: 1,
      },
    });

    // Verify the caps are correctly set — the gateway uses caps.edit to
    // skip editMessage calls for adapters that declare edit: false
    expect(pluginAdapter.caps?.edit).toBe(false);
    expect(pluginAdapter.caps?.contractVersion).toBe(1);
  });

  it('rejects untrusted plugin adapters when trustedChannelPlugins is set', () => {
    const pluginAdapter = stubAdapter({ id: 'untrusted-channel' });
    const factory: PlatformAdapterFactory = vi.fn(() => pluginAdapter);

    const loop = stubLoop();
    new Gateway({
      bots: makeBots(loop),
      pluginAdapters: new Map([['untrusted-plugin/untrusted-channel', factory]]),
      trustedChannelPlugins: new Set(['some-other-plugin']),
      clarifySweepIntervalMs: 0,
    });

    // Factory should NOT have been called — plugin was not trusted
    expect(factory).not.toHaveBeenCalled();
  });

  it('allows all plugin adapters when trustedChannelPlugins is undefined', () => {
    const pluginAdapter = stubAdapter({ id: 'any-channel' });
    const factory: PlatformAdapterFactory = vi.fn(() => pluginAdapter);

    const loop = stubLoop();
    new Gateway({
      bots: makeBots(loop),
      pluginAdapters: new Map([['test-plugin/any-channel', factory]]),
      // trustedChannelPlugins NOT set — all plugins allowed
      clarifySweepIntervalMs: 0,
    });

    expect(factory).toHaveBeenCalled();
  });
});
