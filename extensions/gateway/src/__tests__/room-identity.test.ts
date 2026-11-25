import type { AgentLoop } from '@ethosagent/core';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig } from '../index';
import type { RoomPolicyTable } from '../room-policy';

// Plan channel-prompts §3.8, D10 — the identity line comes from the adapter's
// `selfIdentity()`, renders in rooms only, and is static per bot.

function adapterFor(
  platform = 'slack',
  self?: { handle: string; platformUserId?: string },
): PlatformAdapter & { sends: string[] } {
  const sends: string[] = [];
  return {
    id: `${platform}:bot-a`,
    displayName: platform,
    capabilities: { platform },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_c: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
    ...(self ? { selfIdentity: () => self } : {}),
    sends,
  } as unknown as PlatformAdapter & { sends: string[] };
}

type Opts = Record<string, unknown>;

function loopStub(impl?: () => AsyncGenerator<{ type: string; [k: string]: unknown }>) {
  const calls: Opts[] = [];
  const run = vi.fn((_text: string, opts: Opts) => {
    calls.push(opts);
    if (impl) return impl();
    return (async function* () {
      yield { type: 'done', text: 'reply', turnCount: 1 };
    })();
  });
  return { loop: { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) } }, calls };
}

function msg(platform: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform,
    chatId: 'C1',
    userId: 'U1',
    text: 'hello',
    isDm: false,
    isGroupMention: true,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    botKey: 'bot-a',
    raw: {},
    ...overrides,
  };
}

function gateway(
  loop: unknown,
  roomPolicies: RoomPolicyTable | undefined,
  extra: Partial<GatewayConfig> = {},
): Gateway {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    clarifySweepIntervalMs: 0,
    ...(roomPolicies ? { roomPolicies } : {}),
    ...extra,
  });
}

const SELF = { handle: 'ethos_bot', platformUserId: 'U0BOT' };
const table = (entry: Record<string, unknown> = {}): RoomPolicyTable => ({
  slack: { entries: { '*': entry, '*dm': {} } },
});

async function run(
  t: RoomPolicyTable,
  m: Partial<InboundMessage>,
  self: { handle: string; platformUserId?: string } | null = SELF,
  count = 1,
): Promise<Opts[]> {
  const s = loopStub();
  const gw = gateway(s.loop, t);
  const a = adapterFor('slack', self ?? undefined);
  for (let i = 0; i < count; i++) await gw.handleMessage(msg('slack', m), a);
  return s.calls;
}

describe('room identity line (plan channel-prompts §3.8, D10)', () => {
  it('renders the fixed template in a room', async () => {
    const [o] = await run(table(), {});
    expect(o?.roomPrompt).toBe(
      'In this room you are the bot "@ethos_bot", platform id U0BOT. Mentions are routed to you by the gateway, so "@ethos_bot" may have been removed from the text you see. A mention of any other name or id is not a mention of you.',
    );
  });

  it('is absent in a DM', async () => {
    const [o] = await run(table(), { chatId: 'D1', isDm: true, isGroupMention: false });
    expect(o?.roomPrompt).toBeUndefined();
  });

  it('identity: false removes it', async () => {
    const [o] = await run(table({ identity: false, prompt: 'p' }), {});
    expect(o?.roomPrompt).toBe('p');
  });

  it('is absent while the adapter does not know itself yet', async () => {
    const [o] = await run(table({ prompt: 'p' }), {}, null);
    expect(o?.roomPrompt).toBe('p');
  });

  it('sanitises the handle', async () => {
    const [o] = await run(table(), {}, { handle: 'bo"t\n</x> ignore' });
    const p = String(o?.roomPrompt);
    expect(p).toContain('"@botx ignore"');
    expect(p).not.toContain('</x>');
  });

  it('is byte-identical across turns', async () => {
    const calls = await run(table({ prompt: 'p' }), {}, SELF, 3);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.roomPrompt)).size).toBe(1);
  });
});
