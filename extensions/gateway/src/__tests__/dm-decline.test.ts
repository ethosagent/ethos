// `dmPolicy: decline` in `Gateway.dispatchInbound` (plan hermes-0.22-hardening
// §6): a stranger's DM gets ONE fixed refusal per window, never a turn and
// never a delivery-ledger obligation. Real pairing.db in a tmpdir, so the
// "restart" cases open a second Gateway over the same file.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLoop } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { type SpoolRow, SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import {
  claimDeclineSlot,
  DECLINE_WINDOW_MS,
  DEFAULT_DECLINE_MESSAGE,
  initPairingDb,
} from '@ethosagent/safety-channel';
import Database from '@ethosagent/sqlite';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig, type GatewayObservability } from '../index';

const OWNER = 'owner-1';
const T0 = new Date('2026-09-25T12:00:00Z'); // outside the 22:00-07:00 UTC quiet window
const QUIET = { timeZone: 'UTC', window: { startMinute: 22 * 60, endMinute: 7 * 60 } };

function recordingAdapter(id = 'telegram:bot-a') {
  const sends: Array<{ chatId: string; text: string; threadId?: string }> = [];
  const adapter = {
    id,
    displayName: 'Telegram',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push({ chatId, text: m.text, ...(m.threadId ? { threadId: m.threadId } : {}) });
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return { adapter, sends };
}

function countingLoop() {
  const run = vi.fn(() =>
    (async function* () {
      yield { type: 'done', text: 'reply', turnCount: 1 };
    })(),
  );
  return { loop: { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) } }, run };
}

function dm(userId: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-a',
    chatId: `chat-${userId}`,
    userId,
    text: 'let me in',
    isDm: true,
    isGroupMention: false,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
    ...overrides,
  };
}

type Row = { code?: string; details?: Record<string, unknown> };

function makeObs() {
  return {
    recordSafetyBlock: vi.fn<(opts: Row) => void>(),
    recordChannelAllow: vi.fn<(opts: Row) => void>(),
    recordChannelDeny: vi.fn<(opts: Row) => void>(),
    recordChannelPairing: vi.fn<(opts: Row) => void>(),
  } satisfies GatewayObservability;
}

let dir: string;
let dbs: Database.Database[];

function openPairingDb(): Database.Database {
  const db = new Database(join(dir, 'pairing.db'));
  initPairingDb(db);
  dbs.push(db);
  return db;
}

function makeGateway(opts: {
  db?: Database.Database | null;
  adapter: PlatformAdapter;
  loop: unknown;
  obs?: ReturnType<typeof makeObs>;
  botKeys?: string[];
  extra?: Partial<GatewayConfig>;
}): Gateway {
  const db = opts.db === null ? undefined : (opts.db ?? openPairingDb());
  return new Gateway({
    bots: (opts.botKeys ?? ['bot-a']).map((botKey) => ({
      botKey,
      loop: opts.loop as AgentLoop,
      binding: { type: 'personality' as const, name: 'default' },
    })),
    adapters: new Map([['telegram', opts.adapter]]),
    clarifySweepIntervalMs: 0,
    channelFilter: { telegram: { ownerUserId: OWNER, dmPolicy: 'decline' } },
    ...(db ? { pairingDb: db } : {}),
    ...(opts.obs ? { observability: opts.obs } : {}),
    ...opts.extra,
  });
}

function outcomes(obs: ReturnType<typeof makeObs>): unknown[] {
  return obs.recordSafetyBlock.mock.calls.map((c) => c[0].details?.decline);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dm-decline-'));
  dbs = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('dmPolicy: decline — Gateway.dispatchInbound', () => {
  it("a stranger's first DM under decline gets one refusal and runs no turn", async () => {
    const { adapter, sends } = recordingAdapter();
    const { loop, run } = countingLoop();
    const obs = makeObs();
    const gw = makeGateway({ adapter, loop, obs });

    await gw.handleMessage(dm('stranger', { threadId: 'th-1' }), adapter);

    expect(sends).toEqual([
      { chatId: 'chat-stranger', text: DEFAULT_DECLINE_MESSAGE, threadId: 'th-1' },
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(outcomes(obs)).toEqual(['sent']);
    // The audit row carries neither the stranger's text nor the reply text.
    expect(JSON.stringify(obs.recordSafetyBlock.mock.calls)).not.toContain('let me in');
    expect(JSON.stringify(obs.recordSafetyBlock.mock.calls)).not.toContain(DEFAULT_DECLINE_MESSAGE);
    expect(obs.recordSafetyBlock.mock.calls[0]?.[0].code).toBe('channel.allowlist.blocked');
  });

  it('a second DM inside the window gets nothing and is audited rate_limited', async () => {
    const { adapter, sends } = recordingAdapter();
    const { loop, run } = countingLoop();
    const obs = makeObs();
    const gw = makeGateway({ adapter, loop, obs });

    await gw.handleMessage(dm('stranger'), adapter);
    await gw.handleMessage(dm('stranger'), adapter);
    await gw.handleMessage(dm('stranger'), adapter);

    expect(sends).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
    expect(outcomes(obs)).toEqual(['sent', 'rate_limited', 'rate_limited']);
  });

  it('after the window a new refusal is sent', async () => {
    const { adapter, sends } = recordingAdapter();
    const gw = makeGateway({ adapter, loop: countingLoop().loop });
    // Past the 30s outbound-dedup TTL as well, so only the window is under test.
    await gw.handleMessage(dm('stranger'), adapter);
    vi.setSystemTime(new Date(T0.getTime() + DECLINE_WINDOW_MS + 1));
    await gw.handleMessage(dm('stranger'), adapter);
    expect(sends).toHaveLength(2);
  });

  it('a new Gateway over the same pairing.db does not refuse again inside the window', async () => {
    const first = recordingAdapter();
    const gw1 = makeGateway({ adapter: first.adapter, loop: countingLoop().loop });
    await gw1.handleMessage(dm('stranger'), first.adapter);
    expect(first.sends).toHaveLength(1);

    // A restart: a fresh Gateway, a fresh handle on the same file.
    const second = recordingAdapter();
    const obs = makeObs();
    const gw2 = makeGateway({ adapter: second.adapter, loop: countingLoop().loop, obs });
    await gw2.handleMessage(dm('stranger'), second.adapter);

    expect(second.sends).toHaveLength(0);
    expect(outcomes(obs)).toEqual(['rate_limited']);
  });

  it('inside quiet hours nothing is sent and the window is not spent', async () => {
    const { adapter, sends } = recordingAdapter();
    const obs = makeObs();
    const gw = makeGateway({
      adapter,
      loop: countingLoop().loop,
      obs,
      extra: { quietHours: QUIET },
    });

    vi.setSystemTime(new Date('2026-09-25T23:30:00Z'));
    await gw.handleMessage(dm('stranger'), adapter);
    expect(sends).toHaveLength(0);

    // The hold ended: the stranger's next DM still gets its refusal.
    vi.setSystemTime(new Date('2026-09-26T08:00:00Z'));
    await gw.handleMessage(dm('stranger'), adapter);
    expect(sends).toHaveLength(1);
    expect(outcomes(obs)).toEqual(['held', 'sent']);
  });

  it('a muted lane gets no refusal', async () => {
    const { adapter, sends } = recordingAdapter();
    const obs = makeObs();
    const gw = makeGateway({ adapter, loop: countingLoop().loop, obs });
    // Test-only: an owner `/mute` cannot reach a stranger's lane through the
    // public surface (slash commands run after the filter), so set the map the
    // hold check (`Gateway.noticeHoldReason`) reads.
    const mutes = (gw as unknown as { laneMutes: Map<string, number> }).laneMutes;
    mutes.set('telegram:bot-a:chat-stranger', Date.now() + 60_000);

    await gw.handleMessage(dm('stranger'), adapter);

    expect(sends).toHaveLength(0);
    expect(outcomes(obs)).toEqual(['held']);
  });

  it('an audienceHint shared DM is dropped with no send', async () => {
    const { adapter, sends } = recordingAdapter();
    const { loop, run } = countingLoop();
    const obs = makeObs();
    const gw = makeGateway({ adapter, loop, obs });

    await gw.handleMessage(dm('stranger', { audienceHint: 'shared' }), adapter);

    expect(sends).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    // The plain drop audit, not a decline outcome.
    expect(outcomes(obs)).toEqual([undefined]);
  });

  it('no pairing db wired: nothing is sent, audited unavailable', async () => {
    const { adapter, sends } = recordingAdapter();
    const { loop, run } = countingLoop();
    const obs = makeObs();
    const gw = makeGateway({ db: null, adapter, loop, obs });

    await gw.handleMessage(dm('stranger'), adapter);

    expect(sends).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    expect(outcomes(obs)).toEqual(['unavailable']);
  });

  it('the spool row is closed after a decline', async () => {
    const { adapter } = recordingAdapter();
    const spool = new SQLiteInboundSpool(':memory:');
    const gw = makeGateway({
      adapter,
      loop: countingLoop().loop,
      extra: { inboundSpool: spool, inboundSpoolOptions: { replayIntervalMs: 0 } },
    });

    await gw.handleMessage(dm('stranger'), adapter);

    expect(spool.listReplayable(['bot-a'])).toEqual([]);
    spool.close();
  });

  it('a replayed spool row for a declined DM does not send a second refusal', async () => {
    const { adapter, sends } = recordingAdapter();
    const { loop, run } = countingLoop();
    const obs = makeObs();
    const spool = new SQLiteInboundSpool(':memory:');
    const db = openPairingDb();
    // The first process claimed the slot and sent, then died before closing the row.
    expect(
      claimDeclineSlot(db, { platform: 'telegram', botKey: 'bot-a', senderId: 'stranger' }),
    ).toBe(true);
    const m = dm('stranger', { messageId: 'orphan-1' });
    const { raw: _raw, ...payload } = m;
    spool.accept({
      platform: 'telegram',
      botKey: 'bot-a',
      chatId: m.chatId,
      messageId: 'orphan-1',
      laneKey: `telegram:bot-a:${m.chatId}`,
      payload: JSON.stringify(payload),
      claimedBy: null,
    });
    expect(spool.listReplayable(['bot-a'])).toHaveLength(1);

    const gw = makeGateway({
      db,
      adapter,
      loop,
      obs,
      extra: { inboundSpool: spool, inboundSpoolOptions: { replayIntervalMs: 0 } },
    });
    await gw.replayInboundSpool();

    expect(sends).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    expect(outcomes(obs)).toEqual(['rate_limited']);
    expect(spool.listReplayable(['bot-a']).map((r: SpoolRow) => r.id)).toEqual([]);
    spool.close();
  });

  it('two bots on one platform each send their own refusal', async () => {
    const { adapter, sends } = recordingAdapter();
    const gw = makeGateway({
      adapter,
      loop: countingLoop().loop,
      botKeys: ['bot-a', 'bot-b'],
    });

    await gw.handleMessage(dm('stranger', { botKey: 'bot-a' }), adapter);
    await gw.handleMessage(dm('stranger', { botKey: 'bot-b' }), adapter);

    expect(sends).toHaveLength(2);
  });

  it('the refusal goes through outbound dedup and records no delivery obligation', async () => {
    const { adapter, sends } = recordingAdapter();
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const obs = makeObs();
    const gw = makeGateway({
      adapter,
      loop: countingLoop().loop,
      obs,
      extra: { deliveryLedger: ledger },
    });

    // Two different senders in ONE chat, same refusal text, inside the 30s TTL:
    // both claim a slot, but outboundDedup.shouldSend lets only the first out.
    await gw.handleMessage(dm('stranger-1', { chatId: 'shared-chat' }), adapter);
    await gw.handleMessage(dm('stranger-2', { chatId: 'shared-chat' }), adapter);

    expect(sends).toHaveLength(1);
    // Third row is the legitimate `gateway.dedup_drop` from MessageDedupCache's
    // onDrop (the second refusal's duplicate text); it carries no `decline` key.
    expect(obs.recordSafetyBlock.mock.calls.map((c) => c[0].code)).toEqual([
      'channel.allowlist.blocked',
      'channel.allowlist.blocked',
      'gateway.dedup_drop',
    ]);
    expect(outcomes(obs).slice(0, 2)).toEqual(['sent', 'sent']);
    expect(await ledger.listRecent(10)).toEqual([]);
    ledger.close();
  });
});
