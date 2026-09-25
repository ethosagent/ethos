// `/cmd@bot` — a command addressed to one bot, the form Telegram's command
// menu sends in a group. The gateway reads `/cmd@<its own handle>` as `/cmd`
// and ignores `/cmd@<another bot>` (`commandForThisBot` in ../index.ts). The
// handle comes from the adapter's optional `senderHandle`; without one the
// text is matched exactly, as before.

import type { AgentLoop } from '@ethosagent/core';
import { InMemorySessionStore } from '@ethosagent/core';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig } from '../index';

const LANE = 'telegram:bot-a:chat-1';

function recordingAdapter(senderHandle?: string) {
  const sends: string[] = [];
  const adapter = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
    ...(senderHandle ? { senderHandle } : {}),
  } as unknown as PlatformAdapter;
  return { adapter, sends };
}

function recordingLoop() {
  const turns: Array<{ text: string; sessionKey: string | undefined }> = [];
  const run = vi.fn((text: string, opts: { sessionKey?: string }) => {
    turns.push({ text, sessionKey: opts.sessionKey });
    return (async function* () {
      yield { type: 'done', text: 'reply', turnCount: 1 };
    })();
  });
  return { loop: { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) } }, turns };
}

function msg(text: string): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text,
    isDm: true,
    isGroupMention: false,
    botKey: 'bot-a',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
  };
}

function gateway(loop: unknown, adapter: PlatformAdapter, extra: Partial<GatewayConfig> = {}) {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as AgentLoop,
        binding: { type: 'personality', name: 'default', allowSlashSwitch: true },
      },
    ],
    adapters: new Map([['telegram', adapter]]),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    ...extra,
  });
}

async function storeWithLaneSession() {
  const store = new InMemorySessionStore();
  const root = await store.createSession({
    key: LANE,
    platform: 'telegram',
    model: 'm',
    provider: 'p',
    personalityId: 'default',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      apiCallCount: 0,
      compactionCount: 0,
    },
  });
  await store.appendMessage({ sessionId: root.id, role: 'user', content: 'hi' });
  return store;
}

describe('gateway — /cmd@this_bot runs the command', () => {
  it('/stop@bot and /new@bot are built-in commands, not turns', async () => {
    const out = recordingAdapter('@ethos_bot');
    const s = recordingLoop();
    const gw = gateway(s.loop, out.adapter);
    await gw.handleMessage(msg('/stop@ethos_bot'), out.adapter);
    expect(out.sends.at(-1)).toBe('✓ Stopped.');
    await gw.handleMessage(msg('/new@ethos_bot'), out.adapter);
    expect(out.sends.at(-1)).toBe('✓ New session started.');
    await gw.handleMessage(msg('after'), out.adapter);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.text).toContain('after');
    expect(s.turns[0]?.sessionKey).toMatch(new RegExp(`^${LANE}:\\d+$`));
  });

  it('/personality@bot keeps its arguments', async () => {
    const out = recordingAdapter('@ethos_bot');
    const s = recordingLoop();
    const gw = gateway(s.loop, out.adapter);
    await gw.handleMessage(msg('/personality@ethos_bot'), out.adapter);
    expect(out.sends.at(-1)).toBe('Current personality: default');
    await gw.handleMessage(msg('/personality@ethos_bot list'), out.adapter);
    expect(out.sends.at(-1)).toMatch(/^Built-in personalities:/);
    expect(s.turns).toHaveLength(0);
  });

  it('/fork@bot and /branch@bot <n> run, with the branch number intact', async () => {
    const store = await storeWithLaneSession();
    const out = recordingAdapter('@ethos_bot');
    const s = recordingLoop();
    const gw = gateway(s.loop, out.adapter, { sessionStore: () => store });
    await gw.handleMessage(msg('/fork@ethos_bot'), out.adapter);
    expect(out.sends.at(-1)).toMatch(/^✓ Forked/);
    await gw.handleMessage(msg('/branch@ethos_bot 1'), out.adapter);
    expect(out.sends.at(-1)).toBe('✓ Switched to branch 1.');
    await gw.handleMessage(msg('back home'), out.adapter);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.text).toContain('back home');
    expect(s.turns[0]?.sessionKey).toBe(LANE);
  });

  it('a plugin command with the suffix reaches its handler with its args', async () => {
    const handler = vi.fn(async (_args: string, _ctx: unknown) => 'plugin says hi');
    const out = recordingAdapter('@ethos_bot');
    const s = recordingLoop();
    const gw = gateway(s.loop, out.adapter, {
      pluginLoader: {
        getSlashHandler: (name: string) => (name === 'mycmd' ? handler : undefined),
        getAllSlashCommands: () => [{ name: 'mycmd', description: 'd', usage: '/mycmd' }],
      },
    });
    await gw.handleMessage(msg('/mycmd@ethos_bot arg1 arg2'), out.adapter);
    expect(handler).toHaveBeenCalledWith('arg1 arg2', expect.anything());
    expect(out.sends.at(-1)).toBe('plugin says hi');
    expect(s.turns).toHaveLength(0);
  });

  it('matches the handle case-insensitively', async () => {
    const out = recordingAdapter('@Ethos_Bot');
    const s = recordingLoop();
    const gw = gateway(s.loop, out.adapter);
    await gw.handleMessage(msg('/NEW@ETHOS_BOT'), out.adapter);
    expect(out.sends.at(-1)).toBe('✓ New session started.');
    await gw.handleMessage(msg('/Stop@ethos_bot'), out.adapter);
    expect(out.sends.at(-1)).toBe('✓ Stopped.');
    expect(s.turns).toHaveLength(0);
  });
});

describe('gateway — /cmd@other_bot is ignored', () => {
  it('neither answers nor starts a turn, and records why', async () => {
    const out = recordingAdapter('@ethos_bot');
    const s = recordingLoop();
    const recordSafetyBlock = vi.fn();
    const gw = gateway(s.loop, out.adapter, {
      observability: { recordSafetyBlock } as unknown as GatewayConfig['observability'],
    });
    await gw.handleMessage(msg('/new@other_bot'), out.adapter);
    await gw.handleMessage(msg('/stop@other_bot'), out.adapter);
    await gw.handleMessage(msg('/whatever@other_bot some text'), out.adapter);
    expect(out.sends).toEqual([]);
    expect(s.turns).toHaveLength(0);
    expect(recordSafetyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'gateway.command_for_other_bot' }),
    );
    // …and it did not reset the session: the next turn runs on the lane default.
    await gw.handleMessage(msg('hello'), out.adapter);
    expect(s.turns.map((t) => t.sessionKey)).toEqual([LANE]);
  });
});

describe('gateway — no adapter handle', () => {
  it('matches exactly as before: /new@bot is not a command, /new still is', async () => {
    const out = recordingAdapter();
    const s = recordingLoop();
    const gw = gateway(s.loop, out.adapter);
    await gw.handleMessage(msg('/new@other_bot'), out.adapter);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.text).toContain('/new@other_bot');
    await gw.handleMessage(msg('/new'), out.adapter);
    expect(out.sends.at(-1)).toBe('✓ New session started.');
  });
});
