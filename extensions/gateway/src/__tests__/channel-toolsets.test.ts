import { type AgentLoop, privateChatSetFrom } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_EXCLUDED_TOOLS, Gateway } from '../index';

// Context-economy Phase 1 — static per-channel toolset narrowing. The value
// is resolved from static GatewayConfig only and threaded to the lane turn as
// RunOptions.toolsetNarrow (intersect-only with the personality toolset).

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

function stubLoop() {
  return {
    run: vi.fn(async function* (_text: string, _opts?: Record<string, unknown>) {
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
}

function makeMessage(platform: string): InboundMessage {
  return {
    platform,
    chatId: '100',
    userId: '200',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    messageId: '1',
    botKey: 'test-bot',
    raw: {},
  };
}

function makeGateway(
  loop: ReturnType<typeof stubLoop>,
  channelToolsets?: Record<string, string[]>,
) {
  return new Gateway({
    bots: [
      {
        botKey: 'test-bot',
        loop: loop as unknown as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    clarifySweepIntervalMs: 0,
    ...(channelToolsets ? { channelToolsets } : {}),
  });
}

function runOptions(loop: ReturnType<typeof stubLoop>): Record<string, unknown> {
  const opts = vi.mocked(loop.run).mock.calls[0]?.[1];
  if (!opts || typeof opts !== 'object') throw new Error('loop.run was not called with options');
  return opts;
}

describe('Gateway — static per-channel toolsetNarrow', () => {
  it('passes the configured platform list as toolsetNarrow on lane turns', async () => {
    const loop = stubLoop();
    const gw = makeGateway(loop, { whatsapp: ['read_file', 'memory_read'] });

    await gw.handleMessage(makeMessage('whatsapp'), stubAdapter());

    expect(loop.run).toHaveBeenCalledTimes(1);
    expect(runOptions(loop).toolsetNarrow).toEqual(['read_file', 'memory_read']);
  });

  it('omits toolsetNarrow for platforms without an entry', async () => {
    const loop = stubLoop();
    const gw = makeGateway(loop, { whatsapp: ['read_file'] });

    await gw.handleMessage(makeMessage('telegram'), stubAdapter());

    expect(loop.run).toHaveBeenCalledTimes(1);
    expect('toolsetNarrow' in runOptions(loop)).toBe(false);
  });

  it('omits toolsetNarrow entirely when channelToolsets is unconfigured', async () => {
    const loop = stubLoop();
    const gw = makeGateway(loop);

    await gw.handleMessage(makeMessage('telegram'), stubAdapter());

    expect(loop.run).toHaveBeenCalledTimes(1);
    expect('toolsetNarrow' in runOptions(loop)).toBe(false);
  });
});

// UI-card tools render nothing on a channel adapter, so the gateway subtracts
// them from every lane turn. Unconditional — not config-driven, no opt-out.
describe('Gateway — unconditional channel tool exclusion', () => {
  it('passes CHANNEL_EXCLUDED_TOOLS as toolsetExclude on lane turns', async () => {
    const loop = stubLoop();
    const gw = makeGateway(loop, { whatsapp: ['read_file'] });

    await gw.handleMessage(makeMessage('whatsapp'), stubAdapter());

    expect(runOptions(loop).toolsetExclude).toEqual([...CHANNEL_EXCLUDED_TOOLS]);
  });

  it('passes toolsetExclude even when channelToolsets is unconfigured', async () => {
    const loop = stubLoop();
    const gw = makeGateway(loop);

    await gw.handleMessage(makeMessage('telegram'), stubAdapter());

    expect(runOptions(loop).toolsetExclude).toEqual([...CHANNEL_EXCLUDED_TOOLS]);
  });

  it('covers the UI-card tools', () => {
    expect([...CHANNEL_EXCLUDED_TOOLS].sort()).toEqual(['emit_card', 'render_ui']);
  });
});

// plan personality-memory-boundary step 4 — every lane turn passes the room
// audience (`Gateway.audienceFor`) and `initiator: 'user'` to the loop. The
// memory effect of each value is pinned end to end in
// `memory-boundary-e2e.test.ts`; this pins the options themselves.
describe('Gateway — room audience on lane turns', () => {
  async function optsFor(
    message: InboundMessage,
    config: Partial<ConstructorParameters<typeof Gateway>[0]> = {},
  ): Promise<Record<string, unknown>> {
    const loop = stubLoop();
    const gw = new Gateway({
      bots: [
        {
          botKey: 'test-bot',
          loop: loop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      clarifySweepIntervalMs: 0,
      ...config,
    });
    await gw.handleMessage(message, stubAdapter());
    return runOptions(loop);
  }

  it('a DM is private, started by the user', async () => {
    const opts = await optsFor(makeMessage('telegram'));
    expect(opts.roomAudience).toBe('private');
    expect(opts.initiator).toBe('user');
    expect(opts.skipPersonalityMemory).toBeUndefined();
  });

  it('a group is shared', async () => {
    const opts = await optsFor({ ...makeMessage('telegram'), isDm: false, isGroupMention: true });
    expect(opts.roomAudience).toBe('shared');
    expect(opts.initiator).toBe('user');
  });

  it('a group listed in privateChats is private; the same id on another platform is not', async () => {
    const privateChats = privateChatSetFrom({ telegram: ['100'] });
    const group = { ...makeMessage('telegram'), isDm: false, isGroupMention: true };
    expect((await optsFor(group, { privateChats })).roomAudience).toBe('private');
    expect((await optsFor({ ...group, platform: 'discord' }, { privateChats })).roomAudience).toBe(
      'shared',
    );
  });

  it('a DM hinted shared is shared', async () => {
    const dm = { ...makeMessage('telegram'), audienceHint: 'shared' as const };
    expect((await optsFor(dm)).roomAudience).toBe('shared');
  });

  it('a DM hinted shared is private only when the operator listed its chat', async () => {
    // `(isDm && hint !== 'shared') || privateChats.has(...)`: the listing is
    // the operator's explicit trust, and it wins.
    const dm = { ...makeMessage('telegram'), audienceHint: 'shared' as const };
    const privateChats = privateChatSetFrom({ telegram: ['100'] });
    expect((await optsFor(dm, { privateChats })).roomAudience).toBe('private');
  });

  it('D8: a DM from a non-owner on a platform with an owner withholds personality memory', async () => {
    const channelFilter = { telegram: { ownerUserId: 'owner-1', recipientAllowlist: ['200'] } };
    const stranger = await optsFor(makeMessage('telegram'), { channelFilter });
    expect(stranger.roomAudience).toBe('private');
    expect(stranger.skipPersonalityMemory).toBe(true);
    const owner = await optsFor(
      { ...makeMessage('telegram'), userId: 'owner-1' },
      { channelFilter },
    );
    expect(owner.skipPersonalityMemory).toBeUndefined();
  });

  // plan personality-memory-boundary step 5 — a watcher wake and a webhook
  // are synthesized by Ethos (`initiatorFor`), and a shared one carries the
  // hint (`watcherWakeMessage` / `webhookAudienceHint` in apps/ethos).
  it('a synthesized watcher wake or webhook is system-initiated; its hint decides the audience', async () => {
    const wake = {
      ...makeMessage('telegram'),
      platform: 'watcher',
      chatId: 'watcher:w1',
    };
    const privateWake = await optsFor(wake);
    expect(privateWake.initiator).toBe('system');
    expect(privateWake.roomAudience).toBe('private');
    const sharedWake = await optsFor({ ...wake, audienceHint: 'shared' as const });
    expect(sharedWake.roomAudience).toBe('shared');
    const hook = await optsFor({
      ...makeMessage('telegram'),
      platform: 'webhook',
      chatId: 'hook-1',
      audienceHint: 'shared' as const,
    });
    expect(hook).toMatchObject({ initiator: 'system', roomAudience: 'shared' });
  });
});
