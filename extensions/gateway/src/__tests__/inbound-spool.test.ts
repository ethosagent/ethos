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
import { Gateway, type GatewayConfig, INTERRUPTED_RETRY_NOTICE } from '../index';

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
  // The other branch — a tool had started — is 'a turn that started a tool' below.
  it('a turn cut by a crash before any tool started is replayed exactly once by the next process', async () => {
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

// Plan openclaw-9.5-adoption item 2: the spool row is written BEFORE the
// durable dedup sighting. The two live in different files, so a crash between
// the commits must leave the row (replayed) rather than the sighting (the
// message lost and its platform retry dropped as a duplicate).
describe('inbound spool — dedup ordering', () => {
  it('writes the spool row before the durable sighting', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const rowsAtSighting: number[] = [];
    const inboundDedup = {
      seen: vi.fn(() => {
        rowsAtSighting.push(rows(spool).length);
        return false;
      }),
      close: vi.fn(),
    };
    const gw = gateway(scriptedLoop().loop, out.adapter, spool, { inboundDedup });
    expect(gw.acceptInbound(msg('ordered')).fresh).toBe(true);
    expect(rowsAtSighting).toEqual([1]);
  });

  it('a crash between the row and the sighting: the retry is dropped, the row replays once', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const dedup = new SQLiteInboundDedupStore(':memory:');
    const out = recordingAdapter();
    const m = msg('crash window', { messageId: 'tg-7' });
    // The first process wrote the row and died before its sighting — modelled
    // by a process that has no dedup store at all, then hangs (kill -9).
    const first = scriptedLoop(async function* () {
      await new Promise(() => {});
    });
    void gateway(first.loop, out.adapter, spool).handleMessage(m, out.adapter);
    await waitUntil(() => first.texts.length === 1);

    // Restart. The platform retries the unacknowledged message first.
    const second = scriptedLoop();
    const gw2 = gateway(second.loop, out.adapter, spool, { inboundDedup: dedup });
    await gw2.handleMessage(m, out.adapter);
    expect(second.texts).toHaveLength(0);
    // …and the replay answers it, exactly once.
    await gw2.replayInboundSpool();
    await waitUntil(() => rows(spool)[0]?.status === 'done');
    expect(second.texts).toHaveLength(1);
    expect(rows(spool)).toHaveLength(1);
  });

  it('a sighting the spool never recorded drops the message and closes the fresh row', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const dedup = new SQLiteInboundDedupStore(':memory:');
    // Seen by an earlier process whose spool write failed (fail-open path).
    dedup.seen('telegram', 'bot-a', 'chat-1', 'tg-9');
    const out = recordingAdapter();
    const s = scriptedLoop();
    await gateway(s.loop, out.adapter, spool, { inboundDedup: dedup }).handleMessage(
      msg('retry of an answered message', { messageId: 'tg-9' }),
      out.adapter,
    );
    expect(s.texts).toHaveLength(0);
    expect(rows(spool)).toHaveLength(1);
    expect(rows(spool)[0]?.status).toBe('done');
  });

  it('a failed spool write falls back to dedup alone: processed once, the retry dropped', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    spool.accept = () => {
      throw new Error('disk full');
    };
    const dedup = new SQLiteInboundDedupStore(':memory:');
    const out = recordingAdapter();
    const s = scriptedLoop();
    const gw = gateway(s.loop, out.adapter, spool, { inboundDedup: dedup });
    await gw.handleMessage(msg('undurable', { messageId: 'tg-11' }), out.adapter);
    const restarted = gateway(s.loop, out.adapter, spool, { inboundDedup: dedup });
    await restarted.handleMessage(msg('undurable', { messageId: 'tg-11' }), out.adapter);
    expect(s.texts).toHaveLength(1);
  });

  it('a failed sighting after the row is written still runs the message (fail-open)', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const inboundDedup = {
      seen: vi.fn(() => {
        throw new Error('dedup locked');
      }),
      close: vi.fn(),
    };
    const out = recordingAdapter();
    const s = scriptedLoop();
    const gw = gateway(s.loop, out.adapter, spool, { inboundDedup });
    await gw.handleMessage(msg('keeps going', { messageId: 'tg-12' }), out.adapter);
    expect(s.texts).toHaveLength(1);
    expect(rows(spool)[0]?.status).toBe('done');
    // The spool key still dedups the retry in this process.
    await gw.handleMessage(msg('keeps going', { messageId: 'tg-12' }), out.adapter);
    expect(s.texts).toHaveLength(1);
  });
});

// Plan openclaw-9.5-adoption D5: a turn that had started a tool is never
// replayed. Its row becomes `interrupted`, the lane is told, and only the
// user's `retry` runs it again.
describe('inbound spool — a turn that started a tool', () => {
  /** Yields one tool call, then parks until aborted (or forever). */
  function toolThenPark(): ReturnType<typeof scriptedLoop> {
    return scriptedLoop(async function* (_text, opts) {
      yield { type: 'tool_start', toolCallId: 'c1', toolName: 'pay_invoice', args: {} };
      await new Promise<void>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve());
      });
    });
  }

  /** Crash a first process mid-tool, then boot a second one and replay. */
  async function crashAfterTool(extra: Partial<GatewayConfig> = {}) {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const first = toolThenPark();
    void gateway(first.loop, out.adapter, spool).handleMessage(msg('pay the invoice'), out.adapter);
    await waitUntil(() => rows(spool)[0]?.toolStartedAt !== undefined);
    const second = scriptedLoop();
    const gw2 = gateway(second.loop, out.adapter, spool, extra);
    const result = await gw2.replayInboundSpool();
    return { spool, out, second, gw2, result };
  }

  it('is not replayed after a crash: interrupted, one notice, the tool never re-runs', async () => {
    const { spool, out, second, result } = await crashAfterTool();
    expect(result).toEqual({ replayed: 0, deferred: 0, dead: 0 });
    expect(second.texts).toHaveLength(0);
    expect(rows(spool)[0]).toMatchObject({ status: 'interrupted' });
    expect(out.sends.map((s) => s.text)).toEqual([INTERRUPTED_RETRY_NOTICE]);
  });

  it('`retry` re-runs the original message as a fresh row, exactly once', async () => {
    const { spool, out, second, gw2 } = await crashAfterTool();
    await gw2.handleMessage(msg('  Retry '), out.adapter);
    await waitUntil(() => second.texts.length === 1);
    expect(second.texts[0]).toContain('pay the invoice');
    expect(second.texts[0]).not.toContain('Retry');
    await waitUntil(() => rows(spool).every((r) => r.status === 'done'));
    // The interrupted row, the `retry` message's own row, and the re-run.
    expect(rows(spool)).toHaveLength(3);
    // A second `retry` has nothing left to run: it is an ordinary message now.
    await gw2.handleMessage(msg('retry'), out.adapter);
    await waitUntil(() => second.texts.length === 2);
    expect(second.texts[1]).toContain('retry');
    expect(second.texts[1]).not.toContain('pay the invoice');
  });

  it('any other message discards the interrupted row and runs as itself', async () => {
    const { spool, out, second, gw2 } = await crashAfterTool();
    const interruptedId = rows(spool)[0]?.id ?? '';
    await gw2.handleMessage(msg('never mind, what time is it'), out.adapter);
    expect(second.texts).toHaveLength(1);
    expect(second.texts[0]).toContain('what time is it');
    expect(spool.get(interruptedId)).toMatchObject({ status: 'done', lastError: 'discarded' });
    // …so a later `retry` no longer re-runs it.
    await gw2.handleMessage(msg('retry'), out.adapter);
    expect(second.texts.join('\n')).not.toContain('pay the invoice');
  });

  it('`retry` is not swallowed by a pending clarify the crashed turn left behind', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const { out, second, gw2 } = await crashAfterTool({
      // Would take `retry` as the answer to a question nobody is waiting on.
      clarifyMessageCorrelator: async (m: InboundMessage) =>
        m.text === 'retry' ? ({ id: 'dead-question', answer: 'retry' } as never) : null,
    });
    (second.loop as unknown as { clarifyBridge: unknown }).clarifyBridge = {
      respond,
      recordPresence: vi.fn(),
      sweep: vi.fn(),
    };
    await gw2.handleMessage(msg('retry'), out.adapter);
    await waitUntil(() => second.texts.length === 1);
    expect(second.texts[0]).toContain('pay the invoice');
    expect(respond).not.toHaveBeenCalled();
  });

  it('a `retry` from a sender the safety filter drops re-runs and discards nothing', async () => {
    const { spool, out, second, gw2 } = await crashAfterTool({
      channelFilter: { telegram: { recipientAllowlist: ['user-1'] } } as never,
    });
    await gw2.handleMessage(msg('retry', { userId: 'stranger' }), out.adapter);
    await settle();
    expect(second.texts).toHaveLength(0);
    expect(rows(spool)[0]?.status).toBe('interrupted');
  });

  it('answers `retry` only for a day; after that it is an ordinary message', async () => {
    let t = Date.now() - 25 * 60 * 60 * 1000;
    const spool = new SQLiteInboundSpool(':memory:', { now: () => t });
    const out = recordingAdapter();
    const id = seed(spool, msg('pay the invoice'));
    spool.markInterrupted(id, 'crash');
    t = Date.now();
    const s = scriptedLoop();
    const gw = gateway(s.loop, out.adapter, spool);
    await gw.replayInboundSpool();
    await gw.handleMessage(msg('retry'), out.adapter);
    expect(s.texts).toHaveLength(1);
    expect(s.texts[0]).not.toContain('pay the invoice');
  });

  it('a live turn that throws after a tool started is interrupted, not re-queued', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const s = scriptedLoop(async function* () {
      yield { type: 'tool_start', toolCallId: 'c1', toolName: 'pay_invoice', args: {} };
      throw new Error('loop crashed mid-tool');
    });
    await gateway(s.loop, out.adapter, spool)
      .handleMessage(msg('pay the invoice'), out.adapter)
      .catch(() => {});
    expect(rows(spool)[0]).toMatchObject({ status: 'interrupted' });
    expect(out.sends.map((x) => x.text)).toEqual([INTERRUPTED_RETRY_NOTICE]);
    // Nothing for the next boot to replay.
    const next = scriptedLoop();
    await gateway(next.loop, out.adapter, spool).replayInboundSpool();
    expect(next.texts).toHaveLength(0);
  });
});

// Plan openclaw-9.5-adoption D19: a graceful stop must not tell a lane "please
// resend" when the replay will answer it anyway (that is a double answer).
describe('inbound spool — shutdown notices', () => {
  const RESEND = 'please resend';

  function parkUntilAborted(): ReturnType<typeof scriptedLoop> {
    return scriptedLoop(async function* (_text, opts) {
      await new Promise<void>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve());
      });
    });
  }

  it('a spooled turn with no tool started gets no resend notice, and is replayed', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const s = parkUntilAborted();
    const gw = gateway(s.loop, out.adapter, spool);
    const turn = gw.handleMessage(msg('slow question'), out.adapter);
    await waitUntil(() => s.texts.length === 1);
    await gw.shutdown({ notify: RESEND, drainTimeoutMs: 1000 });
    await turn.catch(() => {});
    expect(out.sends.map((x) => x.text)).toEqual([]);
    expect(rows(spool)[0]?.status).toBe('received');

    const next = scriptedLoop();
    await gateway(next.loop, out.adapter, spool).replayInboundSpool();
    await waitUntil(() => rows(spool)[0]?.status === 'done');
    expect(out.sends.map((x) => x.text)).toEqual(['reply']);
  });

  it('a spooled turn that started a tool is interrupted and gets the retry notice instead', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const s = scriptedLoop(async function* (_text, opts) {
      yield { type: 'tool_start', toolCallId: 'c1', toolName: 'pay_invoice', args: {} };
      await new Promise<void>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve());
      });
    });
    const gw = gateway(s.loop, out.adapter, spool);
    const turn = gw.handleMessage(msg('pay the invoice'), out.adapter);
    await waitUntil(() => rows(spool)[0]?.toolStartedAt !== undefined);
    await gw.shutdown({ notify: RESEND, drainTimeoutMs: 1000 });
    await turn.catch(() => {});
    expect(out.sends.map((x) => x.text)).toEqual([INTERRUPTED_RETRY_NOTICE]);
    expect(rows(spool)[0]?.status).toBe('interrupted');

    // The next process neither replays it nor forgets it: `retry` runs it.
    const next = scriptedLoop();
    const gw2 = gateway(next.loop, out.adapter, spool);
    await gw2.replayInboundSpool();
    expect(next.texts).toHaveLength(0);
    await gw2.handleMessage(msg('retry'), out.adapter);
    await waitUntil(() => next.texts.length === 1);
    expect(next.texts[0]).toContain('pay the invoice');
  });

  it('an unspooled turn keeps the resend notice', async () => {
    const out = recordingAdapter();
    const s = parkUntilAborted();
    const gw = new Gateway({
      bots: [
        { botKey: 'bot-a', loop: s.loop as never, binding: { type: 'personality', name: 'p' } },
      ],
      adapters: new Map([['telegram', out.adapter]]),
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });
    const turn = gw.handleMessage(msg('slow question'), out.adapter);
    await waitUntil(() => s.texts.length === 1);
    await gw.shutdown({ notify: RESEND, drainTimeoutMs: 1000 });
    await turn.catch(() => {});
    expect(out.sends.map((x) => x.text)).toEqual([RESEND]);
  });
});

// Audit G1 (plan openclaw-9.5-adoption D5): a steer message folded into a
// running turn shares that turn's fate. Before the durable link (spool schema
// v3, `absorbed_into`) it replayed after a crash as a standalone turn — and in
// a lane whose primary had just been interrupted, that standalone turn
// discarded the very row the user had been told to `retry`.
describe('inbound spool — absorbed steer rows', () => {
  function toolThenPark(): ReturnType<typeof scriptedLoop> {
    return scriptedLoop(async function* (_text, opts) {
      yield { type: 'tool_start', toolCallId: 'c1', toolName: 'pay_invoice', args: {} };
      await new Promise<void>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve());
      });
    });
  }

  function parkWithoutTool(): ReturnType<typeof scriptedLoop> {
    return scriptedLoop(async function* (_text, opts) {
      await new Promise<void>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve());
      });
    });
  }

  /** A first process starts `primary`, folds `steer` into it, and is left mid-turn. */
  async function primaryWithSteer(loop: ReturnType<typeof scriptedLoop>, withTool: boolean) {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const gw = gateway(loop.loop, out.adapter, spool);
    const turn = gw.handleMessage(msg('pay the invoice'), out.adapter);
    if (withTool) await waitUntil(() => rows(spool)[0]?.toolStartedAt !== undefined);
    else await waitUntil(() => loop.texts.length === 1);
    await gw.handleMessage(msg('and cc finance on it'), out.adapter);
    expect(out.sends.map((s) => s.text)).toEqual(['↩ noted']);
    const [primary, steer] = rows(spool);
    expect(steer?.absorbedInto).toBe(primary?.id);
    out.sends.length = 0;
    return { spool, out, gw, turn };
  }

  async function assertRetryRunsBoth(spool: SQLiteInboundSpool, out: { adapter: PlatformAdapter }) {
    const next = scriptedLoop();
    const gw2 = gateway(next.loop, out.adapter, spool);
    await gw2.replayInboundSpool();
    // Neither the primary nor its steer ran on their own.
    expect(next.texts).toHaveLength(0);
    await gw2.handleMessage(msg('retry'), out.adapter);
    await waitUntil(() => next.texts.length === 1);
    expect(next.texts[0]).toContain('pay the invoice');
    expect(next.texts[0]).toContain('and cc finance on it');
    await waitUntil(() => rows(spool).every((r) => r.status === 'done'));
    expect(next.texts).toHaveLength(1);
  }

  it('tool started + crash: one interrupted notice, the steer never runs alone, retry runs both', async () => {
    const { spool, out } = await primaryWithSteer(toolThenPark(), true);
    // kill -9: the first process never settles anything. The next boot:
    const next = scriptedLoop();
    const gw2 = gateway(next.loop, out.adapter, spool);
    expect(await gw2.replayInboundSpool()).toEqual({ replayed: 0, deferred: 0, dead: 0 });
    expect(next.texts).toHaveLength(0);
    expect(rows(spool).map((r) => r.status)).toEqual(['interrupted', 'interrupted']);
    expect(out.sends.map((s) => s.text)).toEqual([INTERRUPTED_RETRY_NOTICE]);
    // The interrupted row is still there to retry (the steer did not discard it).
    await gw2.handleMessage(msg('retry'), out.adapter);
    await waitUntil(() => next.texts.length === 1);
    expect(next.texts[0]).toContain('pay the invoice');
    expect(next.texts[0]).toContain('and cc finance on it');
    await waitUntil(() => rows(spool).every((r) => r.status === 'done'));
  });

  it('tool started + shutdown: both rows interrupted together, one notice, retry runs both', async () => {
    const { spool, out, gw, turn } = await primaryWithSteer(toolThenPark(), true);
    await gw.shutdown({ notify: 'please resend', drainTimeoutMs: 1000 });
    await turn.catch(() => {});
    expect(rows(spool).map((r) => r.status)).toEqual(['interrupted', 'interrupted']);
    expect(out.sends.map((s) => s.text)).toEqual([INTERRUPTED_RETRY_NOTICE]);
    out.sends.length = 0;
    await assertRetryRunsBoth(spool, out);
  });

  it('no tool + crash: replayed once, as the primary with the steer folded in', async () => {
    const { spool, out } = await primaryWithSteer(parkWithoutTool(), false);
    const next = scriptedLoop();
    const gw2 = gateway(next.loop, out.adapter, spool);
    expect(await gw2.replayInboundSpool()).toEqual({ replayed: 1, deferred: 0, dead: 0 });
    await waitUntil(() => rows(spool).every((r) => r.status === 'done'));
    expect(next.texts).toHaveLength(1);
    const primaryAt = next.texts[0]?.indexOf('pay the invoice') ?? -1;
    const steerAt = next.texts[0]?.indexOf('and cc finance on it') ?? -1;
    expect(primaryAt).toBeGreaterThanOrEqual(0);
    expect(steerAt).toBeGreaterThan(primaryAt);
    expect(out.sends.map((s) => s.text)).toEqual(['reply']);
  });

  it('no tool + shutdown: the steer stays owed with its primary and replays folded in', async () => {
    const { spool, out, gw, turn } = await primaryWithSteer(parkWithoutTool(), false);
    await gw.shutdown({ notify: 'please resend', drainTimeoutMs: 1000 });
    await turn.catch(() => {});
    expect(rows(spool).map((r) => r.status)).toEqual(['received', 'received']);
    expect(out.sends).toHaveLength(0);
    const next = scriptedLoop();
    await gateway(next.loop, out.adapter, spool).replayInboundSpool();
    await waitUntil(() => rows(spool).every((r) => r.status === 'done'));
    expect(next.texts).toHaveLength(1);
    expect(next.texts[0]).toContain('and cc finance on it');
  });
});
