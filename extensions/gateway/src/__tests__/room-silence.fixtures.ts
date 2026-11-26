// Per-room silence (plan channel-prompts L11, D20).
//
// A room that set `silent: true` may end a turn with exactly `NO_REPLY` (or
// `[SILENT]`) and the gateway sends nothing: no message, no empty-reply
// notice. The turn is still COMPLETE for every durability mechanism: no
// ledger obligation to resend, the spool row `done`, a wake review's row
// closed without its plain-notice fallback, no shutdown "please resend". A
// room that did not opt in delivers the marker as ordinary text. These tests
// drive real `SQLiteInboundSpool` / `SQLiteDeliveryLedger` files through real
// Gateways; a second Gateway on the same files is a restart.

import type { AgentLoop } from '@ethosagent/core';
import type { SpoolRow, SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { vi } from 'vitest';
import { Gateway, type GatewayConfig } from '../index';
import type { RoomPolicyTable } from '../room-policy';

export async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

export type Ev = { type: string; [k: string]: unknown };

/** An adapter that records sends and (when `edit`) edits. */
export function recordingAdapter(opts: { edit?: boolean } = {}) {
  const sends: string[] = [];
  const edits: string[] = [];
  const adapter = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: opts.edit === true,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    ...(opts.edit
      ? {
          editMessage: vi.fn(
            async (_c: string, messageId: string, text: string): Promise<DeliveryResult> => {
              edits.push(text);
              return { ok: true, messageId };
            },
          ),
        }
      : {}),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return { adapter, sends, edits };
}

/** A loop that replies with `events` on every turn. */
export function loopYielding(events: Ev[] | (() => AsyncGenerator<Ev>)) {
  const run = vi.fn(() =>
    typeof events === 'function'
      ? events()
      : (async function* () {
          for (const e of events) yield e;
        })(),
  );
  return { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) } };
}

/** A whole reply as one delta and a `done`. */
export function replying(text: string): Ev[] {
  return [
    { type: 'text_delta', text },
    { type: 'done', text, turnCount: 1 },
  ];
}

export function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'nightly digest tick',
    isDm: true,
    isGroupMention: false,
    botKey: 'bot-a',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
    ...overrides,
  };
}

export const SILENT: RoomPolicyTable = { telegram: { entries: { 'chat-1': { silent: true } } } };
export const NOT_SILENT: RoomPolicyTable = {
  telegram: { entries: { 'chat-1': { prompt: 'be brief' } } },
};

export function gateway(
  loop: unknown,
  adapter: PlatformAdapter,
  roomPolicies: RoomPolicyTable | undefined,
  extra: Partial<GatewayConfig> = {},
) {
  const events: Array<{ code: string; details?: Record<string, unknown> }> = [];
  const gw = new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    adapters: new Map([['telegram', adapter]]),
    observability: {
      recordSafetyBlock: (e: { code: string }) => events.push(e),
    } as never,
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    streamingEditIntervalMs: 0,
    ...(roomPolicies ? { roomPolicies } : {}),
    ...extra,
  });
  return { gw, events };
}

export function rows(spool: SQLiteInboundSpool): SpoolRow[] {
  const db = (spool as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db;
  const ids = db.prepare('SELECT id FROM inbound_spool ORDER BY rowid').all() as Array<{
    id: string;
  }>;
  return ids.map(({ id }) => spool.get(id)).filter((r): r is SpoolRow => r !== null);
}

export const silentEvents = <E extends { code: string }>(events: E[]): E[] =>
  events.filter((e) => e.code === 'gateway.silent_reply');
