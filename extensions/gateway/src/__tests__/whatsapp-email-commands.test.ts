// U2 (plan openclaw-2026.9.6-gaps): the gateway-level slash commands are
// handled in `Gateway.handleMessage` by a `PLATFORM_COMMANDS` lookup with NO
// platform gate, so WhatsApp and Email — adapters with no command menu of their
// own — get the same `/stop`, `/new`, `/usage`, `/budget` and `/personality` as
// Telegram. This file pins that for both platforms; the research doc said
// neither had any slash commands.

import type { AgentLoop } from '@ethosagent/core';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

function recordingAdapter(platform: string) {
  const sends: string[] = [];
  const adapter = {
    id: `${platform}:bot-a`,
    displayName: platform,
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
  } as unknown as PlatformAdapter;
  return { adapter, sends };
}

function recordingLoop() {
  const turns: string[] = [];
  const run = vi.fn((text: string) => {
    turns.push(text);
    return (async function* () {
      yield { type: 'done', text: 'reply', turnCount: 1 };
    })();
  });
  return {
    loop: {
      run,
      hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
      getSessionCost: vi.fn().mockReturnValue(0),
      getPersonalityBudgetCap: vi.fn().mockReturnValue(undefined),
      resetSessionCost: vi.fn(),
    },
    turns,
  };
}

function msg(platform: string, text: string): InboundMessage {
  return {
    platform,
    chatId: platform === 'email' ? 'alice@example.com:hello' : '15551234567@s.whatsapp.net',
    userId: platform === 'email' ? 'alice@example.com' : '15551234567@s.whatsapp.net',
    text,
    isDm: true,
    isGroupMention: false,
    botKey: 'bot-a',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
  };
}

function gateway(platform: string, loop: unknown, adapter: PlatformAdapter) {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as AgentLoop,
        binding: { type: 'personality', name: 'default', allowSlashSwitch: true },
      },
    ],
    adapters: new Map([[platform, adapter]]),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
  });
}

describe.each(['whatsapp', 'email'])('gateway slash commands on %s (U2)', (platform) => {
  it('/stop aborts the lane and replies, /new starts a fresh session — neither is a turn', async () => {
    const out = recordingAdapter(platform);
    const s = recordingLoop();
    const gw = gateway(platform, s.loop, out.adapter);
    await gw.handleMessage(msg(platform, '/stop'), out.adapter);
    expect(out.sends.at(-1)).toBe('✓ Stopped.');
    await gw.handleMessage(msg(platform, '/new'), out.adapter);
    expect(out.sends.at(-1)).toBe('✓ New session started.');
    expect(s.turns).toHaveLength(0);
  });

  it('/usage replies with the lane usage line', async () => {
    const out = recordingAdapter(platform);
    const s = recordingLoop();
    const gw = gateway(platform, s.loop, out.adapter);
    await gw.handleMessage(msg(platform, '/usage'), out.adapter);
    expect(out.sends.at(-1)).toBe('Tokens: 0 in / 0 out\nCost: $0.00000');
    expect(s.turns).toHaveLength(0);
  });

  it('/budget replies with the session spend line', async () => {
    const out = recordingAdapter(platform);
    const s = recordingLoop();
    const gw = gateway(platform, s.loop, out.adapter);
    await gw.handleMessage(msg(platform, '/budget'), out.adapter);
    expect(out.sends.at(-1)).toContain('Session spend: $0.0000');
    expect(s.turns).toHaveLength(0);
  });

  it('/personality shows the current personality', async () => {
    const out = recordingAdapter(platform);
    const s = recordingLoop();
    const gw = gateway(platform, s.loop, out.adapter);
    await gw.handleMessage(msg(platform, '/personality'), out.adapter);
    expect(out.sends.at(-1)).toBe('Current personality: default');
    expect(s.turns).toHaveLength(0);
  });
});
