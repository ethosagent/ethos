// Inbound spool — plan reach-and-containment §2.3–§2.5 (Part 2).
//
// Dedup stops double turns, the delivery ledger stops lost replies, and the
// spool stops lost MESSAGES: a `received` row is written in the same
// synchronous span as the dedup check, it becomes `done` only once the turn has
// drained and its answer joined, and `Gateway.replayInboundSpool()` replays
// whatever a crash left behind. These tests drive real `SQLiteInboundSpool`
// files through real Gateways. A second Gateway on the same spool object is a
// process restart: a new claim owner, an empty in-memory state, the same disk.

import type { AgentLoop } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { SQLiteInboundDedupStore } from '@ethosagent/inbound-dedup';
import { type SpoolRow, SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig } from '../index';

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

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

type RunImpl = (
  text: string,
  opts: { abortSignal?: AbortSignal; steerSink?: { drain(): string[] } },
) => AsyncGenerator<{ type: string; [k: string]: unknown }>;

/** A scripted loop. Records every turn's text; `impl` decides what it yields. */
function scriptedLoop(impl?: RunImpl, extra: Record<string, unknown> = {}) {
  const texts: string[] = [];
  const run = vi.fn((text: string, opts: Parameters<RunImpl>[1]) => {
    texts.push(text);
    if (impl) return impl(text, opts);
    return (async function* () {
      yield { type: 'done', text: 'reply', turnCount: 1 };
    })();
  });
  return {
    loop: { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) }, ...extra },
    texts,
  };
}

function msg(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
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
    ...overrides,
  };
}

function gateway(
  loop: unknown,
  adapter: PlatformAdapter,
  spool: SQLiteInboundSpool,
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
    adapters: new Map([['telegram', adapter]]),
    inboundSpool: spool,
    inboundSpoolOptions: { replayIntervalMs: 0 },
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    ...extra,
  });
}

/** Every row, straight off the spool (test-only read). */
function rows(spool: SQLiteInboundSpool): SpoolRow[] {
  const db = (spool as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db;
  const ids = db.prepare('SELECT id FROM inbound_spool ORDER BY rowid').all() as Array<{
    id: string;
  }>;
  return ids.map(({ id }) => spool.get(id)).filter((r): r is SpoolRow => r !== null);
}

/** Seed a row as a previous process would have left it: unclaimed `received`. */
function seed(spool: SQLiteInboundSpool, m: InboundMessage): string {
  const { raw: _raw, ...payload } = m;
  return spool.accept({
    platform: m.platform,
    botKey: m.botKey ?? 'bot-a',
    chatId: m.chatId,
    messageId: m.messageId ?? 'x',
    laneKey: `${m.platform}:${m.botKey ?? 'bot-a'}:${m.chatId}`,
    payload: JSON.stringify(payload),
    claimedBy: null,
  }).id;
}

describe('inbound spool — crash and replay', () => {
  it('a turn cut by a crash before markDone is replayed exactly once by the next process', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    // The first process never finishes its turn — a kill -9 analogue.
    const first = scriptedLoop(async function* () {
      await new Promise(() => {});
    });
    void gateway(first.loop, out.adapter, spool).handleMessage(msg('hello'), out.adapter);
    await waitUntil(() => first.texts.length === 1);
    expect(rows(spool)[0]).toMatchObject({ status: 'processing', attempts: 1 });

    const second = scriptedLoop();
    const gw2 = gateway(second.loop, out.adapter, spool);
    const result = await gw2.replayInboundSpool();
    expect(result).toEqual({ replayed: 1, deferred: 0, dead: 0 });
    await waitUntil(() => rows(spool)[0]?.status === 'done');
    expect(second.texts).toHaveLength(1);
    expect(second.texts[0]).toContain('hello');
    expect(out.sends.map((s) => s.text)).toEqual(['reply']);
    expect(rows(spool)[0]).toMatchObject({ attempts: 2, payload: '{}' });

    // A second replay finds nothing owed.
    expect(await gw2.replayInboundSpool()).toEqual({ replayed: 0, deferred: 0, dead: 0 });
    expect(second.texts).toHaveLength(1);
  });

  it('marks done only after the answer joined — a live turn ends processing → done', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const s = scriptedLoop();
    await gateway(s.loop, out.adapter, spool).handleMessage(msg('hi'), out.adapter);
    expect(rows(spool)).toHaveLength(1);
    expect(rows(spool)[0]).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('the row exists before handleMessage yields — acceptInbound is synchronous', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const gw = gateway(scriptedLoop().loop, out.adapter, spool);
    const accepted = gw.acceptInbound(msg('sync'));
    expect(accepted.fresh).toBe(true);
    expect(accepted.claimed).toBe(true);
    expect(accepted.spoolId && spool.get(accepted.spoolId)?.status).toBe('received');
  });
});

describe('inbound spool — rows closed without a turn', () => {
  it('clarify-consumed, safety-refused and slash-command messages leave the row done', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const respond = vi.fn().mockResolvedValue(undefined);
    const s = scriptedLoop(undefined, {
      clarifyBridge: { respond, recordPresence: vi.fn(), sweep: vi.fn() },
    });
    const gw = gateway(s.loop, out.adapter, spool, {
      clarifyMessageCorrelator: async (m: InboundMessage) =>
        m.text === 'answer' ? ({ id: 'q1', answer: 'yes' } as never) : null,
      channelFilter: { telegram: { recipientAllowlist: ['user-1'] } } as never,
    });

    await gw.handleMessage(msg('answer'), out.adapter);
    await gw.handleMessage(msg('who are you', { userId: 'stranger' }), out.adapter);
    await gw.handleMessage(msg('/usage'), out.adapter);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(s.texts).toHaveLength(0);
    const all = rows(spool);
    expect(all).toHaveLength(3);
    expect(all.every((r) => r.status === 'done')).toBe(true);
    // Nothing is owed, so a restart replays nothing.
    const gw2 = gateway(scriptedLoop().loop, out.adapter, spool);
    expect(await gw2.replayInboundSpool()).toEqual({ replayed: 0, deferred: 0, dead: 0 });
  });

  it('observe-mode records are not spooled at all', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const record = vi.fn().mockResolvedValue(undefined);
    const gw = gateway(scriptedLoop().loop, out.adapter, spool, {
      channelTranscript: { record } as never,
    });
    await gw.handleMessage(msg('watched', { recordOnly: true }), out.adapter);
    expect(record).toHaveBeenCalledTimes(1);
    expect(rows(spool)).toHaveLength(0);
  });

  it('a steer message absorbed into a running turn is done when that turn ends', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = scriptedLoop(async function* () {
      await gate;
      yield { type: 'done', text: 'reply', turnCount: 1 };
    });
    const gw = gateway(s.loop, out.adapter, spool);
    const turn = gw.handleMessage(msg('first'), out.adapter);
    await waitUntil(() => s.texts.length === 1);
    await gw.handleMessage(msg('and also this'), out.adapter);
    expect(out.sends.map((x) => x.text)).toContain('↩ noted');
    // The steer row waits on the absorbing turn.
    expect(rows(spool).map((r) => r.status)).toEqual(['processing', 'received']);

    release();
    await turn;
    expect(rows(spool).map((r) => r.status)).toEqual(['done', 'done']);
    expect(s.texts).toHaveLength(1);
  });
});

describe('inbound spool — shutdown', () => {
  it('a shutdown abort returns the row to received with its attempt refunded', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const s = scriptedLoop(async function* (_text, opts) {
      await new Promise<void>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve());
      });
    });
    const gw = gateway(s.loop, out.adapter, spool);
    const turn = gw.handleMessage(msg('slow'), out.adapter);
    await waitUntil(() => s.texts.length === 1);
    expect(rows(spool)[0]).toMatchObject({ status: 'processing', attempts: 1 });

    await gw.shutdown({ drainTimeoutMs: 1000 });
    await turn.catch(() => {});
    expect(rows(spool)[0]).toMatchObject({ status: 'received', attempts: 0 });
    expect(rows(spool)[0]?.claimedBy).toBeUndefined();

    // …and the next process replays it: attempts 1 after its markProcessing.
    const next = scriptedLoop();
    await gateway(next.loop, out.adapter, spool).replayInboundSpool();
    await waitUntil(() => rows(spool)[0]?.status === 'done');
    expect(rows(spool)[0]?.attempts).toBe(1);
  });
});

describe('inbound spool — no double reply on replay', () => {
  it('skips the turn and closes the row when the ledger already holds its obligation', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const out = recordingAdapter();
    const id = seed(spool, msg('already answered'));
    await ledger.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'chat-1',
      sessionId: 'telegram:bot-a:chat-1',
      content: 'the answer',
      inboundRef: id,
    });
    const s = scriptedLoop();
    const gw = gateway(s.loop, out.adapter, spool, { deliveryLedger: ledger });
    await gw.replayInboundSpool();
    await settle();
    expect(s.texts).toHaveLength(0);
    expect(spool.get(id)?.status).toBe('done');
  });

  it('a live turn stamps its spool id on the reply obligation', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const out = recordingAdapter();
    const gw = gateway(scriptedLoop().loop, out.adapter, spool, { deliveryLedger: ledger });
    await gw.handleMessage(msg('stamp me'), out.adapter);
    const id = rows(spool)[0]?.id ?? '';
    expect(await ledger.hasObligationFor(id)).toBe(true);
  });
});

describe('inbound spool — replay ordering', () => {
  it('replays one lane in order; a live message arriving mid-replay runs after them', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    for (const t of ['one', 'two', 'three']) seed(spool, msg(t));
    let gw: Gateway | undefined;
    let injected = false;
    const s = scriptedLoop(undefined, {
      hooks: {
        registerVoid: vi.fn().mockReturnValue(() => {}),
        // Runs inside dispatchInbound for every message, before it is queued —
        // the one seam that lands a live message while the replay is running.
        fireClaiming: vi.fn(async (_name: string, payload: { text: string }) => {
          if (!injected && payload.text === 'one' && gw) {
            injected = true;
            void gw.handleMessage(msg('live'), out.adapter);
          }
          return { handled: false };
        }),
      },
    });
    gw = gateway(s.loop, out.adapter, spool);
    const result = await gw.replayInboundSpool();
    expect(result.replayed).toBe(4);
    await waitUntil(() => s.texts.length === 4);
    const order = s.texts.map((t) => ['one', 'two', 'three', 'live'].find((w) => t.includes(w)));
    expect(order).toEqual(['one', 'two', 'three', 'live']);
    await waitUntil(() => rows(spool).every((r) => r.status === 'done'));
  });
});

describe('inbound spool — platform redelivery after restart', () => {
  it('the same messageId after the dedup TTL expired runs no second turn', async () => {
    let now = 1_000_000;
    const dedup = new SQLiteInboundDedupStore(':memory:', { now: () => now });
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const m = msg('once', { messageId: 'tg-42' });

    const first = scriptedLoop();
    await gateway(first.loop, out.adapter, spool, { inboundDedup: dedup }).handleMessage(
      m,
      out.adapter,
    );
    expect(first.texts).toHaveLength(1);

    // Two hours later: the dedup sighting has expired, the spool row has not.
    now += 2 * 60 * 60 * 1000;
    const second = scriptedLoop();
    await gateway(second.loop, out.adapter, spool, { inboundDedup: dedup }).handleMessage(
      m,
      out.adapter,
    );
    expect(second.texts).toHaveLength(0);
    expect(rows(spool)).toHaveLength(1);
  });
});

describe('inbound spool — poison message', () => {
  it('a turn that always throws is dead after three boots, and the event is recorded', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const recordSafetyBlock = vi.fn();
    const observability = {
      recordSafetyBlock,
      recordChannelAllow: vi.fn(),
      recordChannelDeny: vi.fn(),
    };
    const poison = (): ReturnType<typeof scriptedLoop> =>
      scriptedLoop(async function* () {
        yield* [];
        throw new Error('tool exploded');
      });

    await gateway(poison().loop, out.adapter, spool, { observability })
      .handleMessage(msg('poison'), out.adapter)
      .catch(() => {});
    expect(rows(spool)[0]).toMatchObject({ status: 'received', attempts: 1 });

    for (const attempts of [2, 3]) {
      await gateway(poison().loop, out.adapter, spool, { observability }).replayInboundSpool();
      await waitUntil(() => rows(spool)[0]?.attempts === attempts);
      await settle();
    }
    expect(rows(spool)[0]).toMatchObject({ status: 'dead', attempts: 3 });
    expect(rows(spool)[0]?.lastError).toContain('tool exploded');
    expect(recordSafetyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'gateway.spool_dead_lettered' }),
    );

    // Dead rows are never auto-replayed.
    const after = scriptedLoop();
    await gateway(after.loop, out.adapter, spool).replayInboundSpool();
    expect(after.texts).toHaveLength(0);
  });
});

describe('inbound spool — ownership', () => {
  it('leaves a row for an unconfigured bot untouched, and never claims one whose adapter is absent', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter('telegram:bot-a');
    const orphan = seed(spool, msg('for a removed bot', { botKey: 'bot-z' }));
    const noAdapter = seed(spool, msg('for bot-b', { botKey: 'bot-b' }));
    const a = scriptedLoop();
    const b = scriptedLoop();
    const gw = new Gateway({
      bots: [
        { botKey: 'bot-a', loop: a.loop as never, binding: { type: 'personality', name: 'p' } },
        { botKey: 'bot-b', loop: b.loop as never, binding: { type: 'personality', name: 'p' } },
      ],
      adapters: new Map([['telegram', out.adapter]]),
      inboundSpool: spool,
      inboundSpoolOptions: { replayIntervalMs: 0 },
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });
    const result = await gw.replayInboundSpool();
    expect(result).toEqual({ replayed: 0, deferred: 1, dead: 0 });
    expect(spool.get(orphan)).toMatchObject({ status: 'received' });
    expect(spool.get(orphan)?.claimedBy).toBeUndefined();
    expect(spool.get(noAdapter)).toMatchObject({ status: 'received' });
    expect(spool.get(noAdapter)?.claimedBy).toBeUndefined();
    expect(a.texts).toHaveLength(0);
    expect(b.texts).toHaveLength(0);
  });
});

describe('inbound spool — stale rows', () => {
  it('a row older than a day is dead-lettered as stale, with one notice per lane', async () => {
    let t = Date.now() - 25 * 60 * 60 * 1000;
    const spool = new SQLiteInboundSpool(':memory:', { now: () => t });
    const out = recordingAdapter();
    const one = seed(spool, msg('old one'));
    const two = seed(spool, msg('old two'));
    t = Date.now();
    const s = scriptedLoop();
    const result = await gateway(s.loop, out.adapter, spool).replayInboundSpool();
    expect(result).toEqual({ replayed: 0, deferred: 0, dead: 2 });
    expect(spool.get(one)).toMatchObject({ status: 'dead', lastError: 'stale' });
    expect(spool.get(two)).toMatchObject({ status: 'dead', lastError: 'stale' });
    expect(s.texts).toHaveLength(0);
    expect(out.sends.map((x) => x.text)).toEqual([
      'I restarted and missed 2 message(s) older than a day; resend if still needed.',
    ]);
  });
});
