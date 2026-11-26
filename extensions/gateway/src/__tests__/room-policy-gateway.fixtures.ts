// Per-room prompt wiring (plan channel-prompts L3b, L5, D8): Gateway.runTurn
// resolves the room policy once per lane and hands AgentLoop.run the rendered
// block. Every route into runTurn (message, wake review, spool replay, voice
// note, Slack /ethos ask) must see the same bytes for the same room.

import type { AgentLoop } from '@ethosagent/core';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { expect, vi } from 'vitest';
import { Gateway, type GatewayConfig } from '../index';
import type { RoomPolicyTable } from '../room-policy';

export async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

export function adapterFor(platform = 'telegram'): PlatformAdapter & { sends: string[] } {
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
    sends,
  } as unknown as PlatformAdapter & { sends: string[] };
}

export type Opts = Record<string, unknown>;

export function loopStub(impl?: () => AsyncGenerator<{ type: string; [k: string]: unknown }>) {
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

export function msg(platform: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
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

export function gateway(
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

export async function roomOpts(
  platform: string,
  message: Partial<InboundMessage>,
  table: RoomPolicyTable | undefined,
): Promise<Opts> {
  const s = loopStub();
  await gateway(s.loop, table).handleMessage(msg(platform, message), adapterFor(platform));
  expect(s.calls).toHaveLength(1);
  return s.calls[0] as Opts;
}
