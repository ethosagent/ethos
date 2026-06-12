import type { AgentLoop } from '@ethosagent/core';
import type { InboundMessage, NotificationRouter, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

// G3/G10 — plugin slash command dispatch, pluginsReady adapter registration,
// and notificationRouter wiring through the gateway turn lifecycle.

// ---------------------------------------------------------------------------
// Minimal stubs
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
    platform: 'telegram',
    chatId: '100',
    userId: '200',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    messageId: '1',
    botKey: 'test-bot',
    raw: {},
    ...overrides,
  };
}

function makeBots(loop: ReturnType<typeof stubLoop>) {
  return [
    {
      botKey: 'test-bot',
      loop: loop as unknown as AgentLoop,
      binding: { type: 'personality' as const, name: 'default' },
    },
  ];
}

const PLUGIN_LOADER = {
  getSlashHandler(name: string) {
    return name === 'mycmd' ? handlerSpy : undefined;
  },
  getAllSlashCommands() {
    return [{ name: 'mycmd', description: 'My plugin command', usage: '/mycmd <arg>' }];
  },
};
const handlerSpy = vi.fn(async (_args: string, _ctx: unknown) => 'plugin says hi');

describe('Gateway — plugin slash commands', () => {
  it('dispatches /mycmd to the plugin handler and sends the reply (no agent turn)', async () => {
    handlerSpy.mockClear();
    const loop = stubLoop();
    const gw = new Gateway({
      bots: makeBots(loop),
      pluginLoader: PLUGIN_LOADER,
      clarifySweepIntervalMs: 0,
    });
    const adapter = stubAdapter();

    await gw.handleMessage(makeMessage({ text: '/mycmd arg1 arg2' }), adapter);

    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(handlerSpy).toHaveBeenCalledWith(
      'arg1 arg2',
      expect.objectContaining({ platform: 'telegram', sessionId: expect.any(String) }),
    );
    expect(adapter.send).toHaveBeenCalledWith(
      '100',
      expect.objectContaining({ text: 'plugin says hi' }),
    );
    expect(loop.run).not.toHaveBeenCalled();
  });

  it('falls through to the agent turn for unknown slash commands', async () => {
    const loop = stubLoop();
    const gw = new Gateway({
      bots: makeBots(loop),
      pluginLoader: PLUGIN_LOADER,
      clarifySweepIntervalMs: 0,
    });
    const adapter = stubAdapter();

    await gw.handleMessage(makeMessage({ text: '/unknowncmd hello' }), adapter);

    expect(loop.run).toHaveBeenCalledTimes(1);
  });

  it('pluginsReady pushes plugin commands to every registered adapter', async () => {
    const registerCommands = vi.fn().mockResolvedValue(undefined);
    const adapter = stubAdapter({ registerCommands });
    const gw = new Gateway({
      bots: makeBots(stubLoop()),
      pluginLoader: PLUGIN_LOADER,
      adapters: new Map([['telegram', adapter]]),
      clarifySweepIntervalMs: 0,
    });

    await gw.pluginsReady();

    expect(registerCommands).toHaveBeenCalledTimes(1);
    expect(registerCommands).toHaveBeenCalledWith([
      { name: 'mycmd', description: 'My plugin command' },
    ]);
  });

  it('pluginsReady is a no-op when there are no plugin commands', async () => {
    const registerCommands = vi.fn().mockResolvedValue(undefined);
    const adapter = stubAdapter({ registerCommands });
    const gw = new Gateway({
      bots: makeBots(stubLoop()),
      pluginLoader: { getSlashHandler: () => undefined, getAllSlashCommands: () => [] },
      adapters: new Map([['telegram', adapter]]),
      clarifySweepIntervalMs: 0,
    });

    await gw.pluginsReady();

    expect(registerCommands).not.toHaveBeenCalled();
  });
});

describe('Gateway — notificationRouter wiring (Gap 10)', () => {
  it('registers a per-session adapter on the router and buffers notes after the turn', async () => {
    const loop = stubLoop();
    const register = vi.fn();
    const router: NotificationRouter = {
      route: vi.fn().mockResolvedValue(undefined),
      register,
      deregister: vi.fn(),
    };
    const gw = new Gateway({
      bots: makeBots(loop),
      notificationRouter: router,
      clarifySweepIntervalMs: 0,
    });
    const adapter = stubAdapter();

    await gw.handleMessage(makeMessage(), adapter);

    expect(register).toHaveBeenCalledTimes(1);
    const [sessionKey, notificationAdapter] = register.mock.calls[0] as [
      string,
      { send: (text: string) => Promise<void> },
    ];
    expect(sessionKey).toBe('telegram:test-bot:100');

    // Turn has ended — a notification now lands in the unread buffer, not
    // the channel.
    const sendsBefore = vi.mocked(adapter.send).mock.calls.length;
    await notificationAdapter.send('process abc complete');
    expect(vi.mocked(adapter.send).mock.calls.length).toBe(sendsBefore);

    // The next turn flushes the buffered note to the chat first.
    await gw.handleMessage(makeMessage({ messageId: '2' }), adapter);
    expect(adapter.send).toHaveBeenCalledWith(
      '100',
      expect.objectContaining({ text: 'process abc complete' }),
    );
  });
});
