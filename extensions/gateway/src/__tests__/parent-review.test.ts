// Parent reviews the background result first — plan openclaw-9.5-adoption
// item 6 (D10, D29, D30).
//
// A `deliver: 'parent'` job does not wake the user with its raw result. The
// gateway admits a `wake_review` spool row, takes the job's delivery claim,
// and runs ONE review turn on the job's origin lane; the user sees that turn's
// answer. Whatever goes wrong — an error, an empty answer, a crash after a tool
// started — the user gets the plain wake notice instead: never nothing, never
// both. These tests drive real `SQLiteInboundSpool` / `SQLiteDeliveryLedger`
// files through real Gateways; a second Gateway on the same files is a restart.

import type { AgentLoop } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { type SpoolRow, SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import type {
  BackgroundJob,
  DeliveryResult,
  InboundMessage,
  JobStore,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig, type HeldNotice, type HeldNoticeStore } from '../index';

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

function recordingAdapter() {
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
  } as unknown as PlatformAdapter;
  return { adapter, sends };
}

interface RunOpts {
  abortSignal?: AbortSignal;
  reviewOfJobId?: string;
}
type RunImpl = (
  text: string,
  opts: RunOpts,
) => AsyncGenerator<{ type: string; [k: string]: unknown }>;

function scriptedLoop(impl?: RunImpl) {
  const calls: Array<{ text: string; reviewOfJobId?: string }> = [];
  const run = vi.fn((text: string, opts: RunOpts) => {
    calls.push({ text, ...(opts.reviewOfJobId ? { reviewOfJobId: opts.reviewOfJobId } : {}) });
    if (impl) return impl(text, opts);
    return (async function* () {
      yield { type: 'text_delta', text: 'Reviewed: the build is green.' };
      yield { type: 'done', text: 'Reviewed: the build is green.', turnCount: 1 };
    })();
  });
  return {
    loop: { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) } },
    calls,
  };
}

/** Only the delivery-claim surface the wake path touches. */
function fakeJobStore(jobs: BackgroundJob[]) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const store = {
    get: async (id: string) => byId.get(id) ?? null,
    claimDelivery: vi.fn(async (id: string) => {
      const job = byId.get(id);
      if (!job || job.deliveredAt !== undefined) return false;
      job.deliveredAt = Date.now();
      return true;
    }),
    releaseDelivery: async (id: string) => {
      const job = byId.get(id);
      if (job) job.deliveredAt = undefined;
    },
    listUndelivered: async (botKeys: string[]) =>
      [...byId.values()].filter(
        (j) => j.deliveredAt === undefined && botKeys.includes(j.originBotKey ?? ''),
      ),
  };
  return store as typeof store & JobStore;
}

function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'job-1234abcd',
    owner: 'proc-1',
    parentSessionKey: 'telegram:bot-a:chat-1',
    rootSessionKey: 'telegram:bot-a:chat-1',
    childSessionKey: 'child',
    depth: 1,
    status: 'done',
    prompt: 'check the build',
    summary: 'CI run 812: all 4,211 tests passed',
    spendUsd: 0,
    createdAt: Date.now(),
    originPlatform: 'telegram',
    originBotKey: 'bot-a',
    originChatId: 'chat-1',
    deliver: 'parent',
    ...overrides,
  };
}

/** A fake executor: `fire(job)` is a terminal transition. */
function fakeExecutor() {
  const handlers: Array<(j: BackgroundJob) => void> = [];
  return {
    executor: {
      owner: 'proc-1',
      nudge: vi.fn(),
      onComplete: (h: (j: BackgroundJob) => void) => {
        handlers.push(h);
        return () => {};
      },
    },
    fire: (j: BackgroundJob) => {
      for (const h of handlers) h(j);
    },
  };
}

function gateway(
  loop: unknown,
  adapter: PlatformAdapter,
  store: JobStore,
  spool: SQLiteInboundSpool,
  extra: Partial<GatewayConfig> & { executor?: unknown } = {},
): Gateway {
  const { executor, ...rest } = extra;
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as AgentLoop,
        binding: { type: 'personality', name: 'default' },
        jobStore: store,
        ...(executor ? { backgroundExecutor: executor as never } : {}),
      },
    ],
    adapters: new Map([['telegram', adapter]]),
    inboundSpool: spool,
    inboundSpoolOptions: { replayIntervalMs: 0 },
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    ...rest,
  });
}

function rows(spool: SQLiteInboundSpool): SpoolRow[] {
  const db = (spool as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db;
  const ids = db.prepare('SELECT id FROM inbound_spool ORDER BY rowid').all() as Array<{
    id: string;
  }>;
  return ids.map(({ id }) => spool.get(id)).filter((r): r is SpoolRow => r !== null);
}

const PLAIN = '[background job job-1234';

describe("parent review — deliver: 'parent'", () => {
  it('runs one review turn instead of the plain notice; its answer is what the user sees', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const out = recordingAdapter();
    const j = job();
    const s = scriptedLoop();
    const exec = fakeExecutor();
    gateway(s.loop, out.adapter, fakeJobStore([j]), spool, {
      executor: exec.executor,
      deliveryLedger: ledger,
    });
    exec.fire(j);
    await waitUntil(() => rows(spool)[0]?.status === 'done');

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.reviewOfJobId).toBe(j.id);
    // The trusted instruction, then the envelope, then the result still wrapped.
    expect(s.calls[0]?.text).toContain('A background task you delegated has finished');
    expect(s.calls[0]?.text).toContain('[background job job-1234');
    expect(s.calls[0]?.text).toContain('CI run 812');
    expect(out.sends).toEqual(['Reviewed: the build is green.']);
    expect(j.deliveredAt).toBeGreaterThan(0);
    expect(rows(spool)[0]).toMatchObject({
      kind: 'wake_review',
      reviewJobId: j.id,
      messageId: `wake:${j.id}`,
    });
    // The reply is a ledger obligation stamped with the row (the replay guard).
    expect(await ledger.hasObligationFor(rows(spool)[0]?.id ?? '')).toBe(true);
  });

  it("the default 'user' keeps the plain notice and admits no review", async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const j = job({ deliver: 'user' });
    const s = scriptedLoop();
    const exec = fakeExecutor();
    gateway(s.loop, out.adapter, fakeJobStore([j]), spool, { executor: exec.executor });
    exec.fire(j);
    await waitUntil(() => out.sends.length === 1);
    expect(out.sends[0]).toContain(PLAIN);
    expect(s.calls).toHaveLength(0);
    expect(rows(spool)).toHaveLength(0);
  });

  for (const [name, impl] of [
    [
      'an error event',
      async function* () {
        yield { type: 'error', error: 'provider down', code: 'llm_error' };
      },
    ],
    [
      'an empty answer',
      async function* () {
        yield { type: 'done', text: '', turnCount: 1 };
      },
    ],
    [
      'a throw',
      async function* () {
        yield* [];
        throw new Error('loop exploded');
      },
    ],
  ] as Array<[string, RunImpl]>) {
    it(`falls back to the plain notice on ${name} — exactly once`, async () => {
      const spool = new SQLiteInboundSpool(':memory:');
      const out = recordingAdapter();
      const j = job();
      const s = scriptedLoop(impl);
      const exec = fakeExecutor();
      gateway(s.loop, out.adapter, fakeJobStore([j]), spool, { executor: exec.executor });
      exec.fire(j);
      await waitUntil(() => rows(spool)[0]?.status === 'done');
      await settle();
      expect(out.sends).toHaveLength(1);
      expect(out.sends[0]).toContain(PLAIN);
      expect(out.sends[0]).toContain('CI run 812');
    });
  }

  it('a pending clarify never sees the review turn', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const j = job();
    const s = scriptedLoop();
    const exec = fakeExecutor();
    const correlator = vi.fn(async (_m: InboundMessage) => ({ id: 'q', answer: 'x' }) as never);
    gateway(s.loop, out.adapter, fakeJobStore([j]), spool, {
      executor: exec.executor,
      clarifyMessageCorrelator: correlator,
    });
    exec.fire(j);
    await waitUntil(() => out.sends.length === 1);
    expect(correlator).not.toHaveBeenCalled();
    expect(out.sends).toEqual(['Reviewed: the build is green.']);
  });

  it('a lost delivery claim closes the row and runs nothing', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const j = job({ deliveredAt: Date.now() - 1000 });
    const s = scriptedLoop();
    const exec = fakeExecutor();
    gateway(s.loop, out.adapter, fakeJobStore([j]), spool, { executor: exec.executor });
    exec.fire(j);
    await waitUntil(() => rows(spool)[0]?.status === 'done');
    await settle();
    expect(s.calls).toHaveLength(0);
    expect(out.sends).toHaveLength(0);
  });

  it('the restore sweep admits a review for a job that finished while the process was down', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const j = job();
    const s = scriptedLoop();
    const gw = gateway(s.loop, out.adapter, fakeJobStore([j]), spool);
    expect(await gw.sweepUndeliveredJobs()).toEqual({ delivered: 1, failed: 0 });
    await waitUntil(() => out.sends.length === 1);
    expect(out.sends).toEqual(['Reviewed: the build is green.']);
    expect(s.calls[0]?.reviewOfJobId).toBe(j.id);
    // Idempotent: a second sweep has nothing left.
    expect(await gw.sweepUndeliveredJobs()).toEqual({ delivered: 0, failed: 0 });
    expect(rows(spool)).toHaveLength(1);
  });
});

describe('parent review — a crash mid-review', () => {
  /** First process: admit the review, let `impl` run it, then "kill -9". */
  async function crashDuringReview(impl: RunImpl) {
    const spool = new SQLiteInboundSpool(':memory:');
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const out = recordingAdapter();
    const j = job();
    const store = fakeJobStore([j]);
    const first = scriptedLoop(impl);
    const exec = fakeExecutor();
    gateway(first.loop, out.adapter, store, spool, {
      executor: exec.executor,
      deliveryLedger: ledger,
    });
    exec.fire(j);
    await waitUntil(() => first.calls.length === 1);
    return { spool, ledger, out, store, j };
  }

  it('with no tool started, the next process replays the review — one answer', async () => {
    const { spool, ledger, out, store, j } = await crashDuringReview(async function* () {
      await new Promise(() => {});
    });
    const second = scriptedLoop();
    const gw2 = gateway(second.loop, out.adapter, store, spool, { deliveryLedger: ledger });
    // The job is already claimed, so the sweep does not re-admit it…
    expect(await gw2.sweepUndeliveredJobs()).toEqual({ delivered: 0, failed: 0 });
    // …the spool replay owns it.
    await gw2.replayInboundSpool();
    await waitUntil(() => rows(spool)[0]?.status === 'done');
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.reviewOfJobId).toBe(j.id);
    expect(out.sends).toEqual(['Reviewed: the build is green.']);
  });

  it('with a tool started, the next process sends the plain notice and re-runs nothing', async () => {
    const { spool, ledger, out, store } = await crashDuringReview(async function* () {
      yield { type: 'tool_start', toolCallId: 'c1', toolName: 'post_update', args: {} };
      await new Promise(() => {});
    });
    await waitUntil(() => rows(spool)[0]?.toolStartedAt !== undefined);
    const second = scriptedLoop();
    const gw2 = gateway(second.loop, out.adapter, store, spool, { deliveryLedger: ledger });
    await gw2.replayInboundSpool();
    await waitUntil(() => rows(spool)[0]?.status === 'done');
    expect(second.calls).toHaveLength(0);
    expect(out.sends).toHaveLength(1);
    expect(out.sends[0]).toContain(PLAIN);
    // A third boot has nothing left to send.
    await gateway(scriptedLoop().loop, out.adapter, store, spool, {
      deliveryLedger: ledger,
    }).replayInboundSpool();
    await settle();
    expect(out.sends).toHaveLength(1);
  });

  it('a review whose reply was recorded before the crash is not run again', async () => {
    const { spool, ledger, out, store } = await crashDuringReview(async function* () {
      yield { type: 'text_delta', text: 'Reviewed.' };
      yield { type: 'done', text: 'Reviewed.', turnCount: 1 };
      // The turn-end tail parks: the reply is out, the row is still processing.
      await new Promise(() => {});
    });
    await waitUntil(() => out.sends.length === 1);
    const second = scriptedLoop();
    await gateway(second.loop, out.adapter, store, spool, {
      deliveryLedger: ledger,
    }).replayInboundSpool();
    await settle();
    expect(second.calls).toHaveLength(0);
    expect(out.sends).toEqual(['Reviewed.']);
    expect(rows(spool)[0]?.status).toBe('done');
  });

  it('a stale review row falls back to the plain notice rather than a dead letter', async () => {
    let t = Date.now() - 25 * 60 * 60 * 1000;
    const spool = new SQLiteInboundSpool(':memory:', { now: () => t });
    const out = recordingAdapter();
    const j = job();
    const first = scriptedLoop(async function* () {
      await new Promise(() => {});
    });
    const exec = fakeExecutor();
    gateway(first.loop, out.adapter, fakeJobStore([j]), spool, { executor: exec.executor });
    exec.fire(j);
    await waitUntil(() => first.calls.length === 1);
    t = Date.now();
    const second = scriptedLoop();
    await gateway(second.loop, out.adapter, fakeJobStore([j]), spool).replayInboundSpool();
    await waitUntil(() => rows(spool)[0]?.status === 'done');
    expect(second.calls).toHaveLength(0);
    expect(out.sends).toHaveLength(1);
    expect(out.sends[0]).toContain(PLAIN);
  });
});

describe('parent review — shutdown', () => {
  it('no tool started: no notice now, the review is replayed after the restart', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const j = job();
    const store = fakeJobStore([j]);
    const s = scriptedLoop(async function* (_t, opts) {
      await new Promise<void>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve());
      });
    });
    const exec = fakeExecutor();
    const gw = gateway(s.loop, out.adapter, store, spool, { executor: exec.executor });
    exec.fire(j);
    await waitUntil(() => s.calls.length === 1);
    await gw.shutdown({ notify: 'please resend', drainTimeoutMs: 1000 });
    expect(out.sends).toEqual([]);
    expect(rows(spool)[0]?.status).toBe('received');

    const next = scriptedLoop();
    await gateway(next.loop, out.adapter, store, spool).replayInboundSpool();
    await waitUntil(() => rows(spool)[0]?.status === 'done');
    expect(out.sends).toEqual(['Reviewed: the build is green.']);
  });

  it('a tool started: the plain notice goes out as the review unwinds', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const j = job();
    const s = scriptedLoop(async function* (_t, opts) {
      yield { type: 'tool_start', toolCallId: 'c1', toolName: 'post_update', args: {} };
      await new Promise<void>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve());
      });
    });
    const exec = fakeExecutor();
    const gw = gateway(s.loop, out.adapter, fakeJobStore([j]), spool, {
      executor: exec.executor,
    });
    exec.fire(j);
    await waitUntil(() => rows(spool)[0]?.toolStartedAt !== undefined);
    await gw.shutdown({ notify: 'please resend', drainTimeoutMs: 1000 });
    expect(out.sends).toHaveLength(1);
    expect(out.sends[0]).toContain(PLAIN);
    expect(rows(spool)[0]?.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// U11 — a review is an unprompted message like any wake notice. Before this,
// `/mute` and quiet hours held the plain notice (`deliverCompletion`) but a
// `deliver: 'parent'` job went straight to `admitWakeReview` → `enqueueTurn`:
// a paid turn ran into a muted lane and its answer was sent. Now the review is
// parked, unclaimed, until the hold ends, then runs once.
// ---------------------------------------------------------------------------

class MemoryHeldNotices implements HeldNoticeStore {
  rows: HeldNotice[] = [];
  private seq = 0;
  async hold(notice: Omit<HeldNotice, 'id' | 'heldAt'>): Promise<void> {
    this.rows.push({ ...notice, id: ++this.seq, heldAt: Date.now() });
  }
  async listHeld(): Promise<HeldNotice[]> {
    return [...this.rows];
  }
  async markReleased(id: number): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
}

function dm(text: string, messageId: string): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'u1',
    botKey: 'bot-a',
    text,
    isDm: true,
    isGroupMention: false,
    messageId,
    raw: {},
  };
}

describe('parent review — held by /mute and quiet hours (U11)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('/mute 8h: no review turn runs and nothing is sent; after the mute ends it runs once', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const out = recordingAdapter();
    const j = job();
    const s = scriptedLoop();
    const exec = fakeExecutor();
    const gw = gateway(s.loop, out.adapter, fakeJobStore([j]), spool, {
      executor: exec.executor,
      deliveryLedger: ledger,
      heldNotices: new MemoryHeldNotices(),
    });
    await gw.handleMessage(dm('/mute 8h', 'm1'), out.adapter);
    const acks = out.sends.length;

    exec.fire(j);
    await settle();
    await gw.sweepPendingDeliveries();
    await settle();
    expect(s.calls).toHaveLength(0);
    expect(out.sends.slice(acks)).toEqual([]);
    expect(rows(spool).filter((r) => r.kind === 'wake_review')).toEqual([]);
    // Unclaimed: a restart while muted re-owes it through sweepUndeliveredJobs.
    expect(j.deliveredAt).toBeUndefined();

    await gw.handleMessage(dm('/mute off', 'm2'), out.adapter);
    const afterUnmute = out.sends.length;
    await gw.sweepPendingDeliveries();
    await waitUntil(() => rows(spool).find((r) => r.kind === 'wake_review')?.status === 'done');
    await gw.sweepPendingDeliveries();
    await settle();

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.reviewOfJobId).toBe(j.id);
    expect(out.sends.slice(afterUnmute)).toEqual(['Reviewed: the build is green.']);
    expect(j.deliveredAt).toBeGreaterThan(0);
  });

  it('quiet hours: the restore sweep parks the review and the window end releases it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T23:30:00Z'));
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const j = job();
    const s = scriptedLoop();
    const gw = gateway(s.loop, out.adapter, fakeJobStore([j]), spool, {
      deliveryLedger: new SQLiteDeliveryLedger(':memory:'),
      heldNotices: new MemoryHeldNotices(),
      quietHours: { timeZone: 'UTC', window: { startMinute: 22 * 60, endMinute: 7 * 60 } },
    });

    await gw.sweepUndeliveredJobs();
    await settle();
    expect(s.calls).toHaveLength(0);
    expect(out.sends).toEqual([]);
    expect(j.deliveredAt).toBeUndefined();

    vi.setSystemTime(new Date('2026-09-26T07:01:00Z'));
    await gw.sweepPendingDeliveries();
    await waitUntil(() => rows(spool)[0]?.status === 'done');
    expect(s.calls).toHaveLength(1);
    expect(out.sends).toEqual(['Reviewed: the build is green.']);
  });

  it('a review that falls back inside quiet hours holds the plain notice, then sends it once', async () => {
    // A review admitted before the window, crashed after a tool started: the
    // next process owes the plain notice — inside quiet hours it is held.
    const spool = new SQLiteInboundSpool(':memory:');
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const out = recordingAdapter();
    const j = job();
    const store = fakeJobStore([j]);
    const first = scriptedLoop(async function* () {
      yield { type: 'tool_start', toolCallId: 'c1', toolName: 'post_update', args: {} };
      await new Promise(() => {});
    });
    const exec = fakeExecutor();
    gateway(first.loop, out.adapter, store, spool, {
      executor: exec.executor,
      deliveryLedger: ledger,
    });
    exec.fire(j);
    await waitUntil(() => rows(spool)[0]?.toolStartedAt !== undefined);

    // A quiet window around the current UTC time, so no clock goes backwards.
    const nowMin = Math.floor((Date.now() % 86_400_000) / 60_000);
    const held = new MemoryHeldNotices();
    const gw2 = gateway(scriptedLoop().loop, out.adapter, store, spool, {
      deliveryLedger: ledger,
      heldNotices: held,
      quietHours: {
        timeZone: 'UTC',
        window: { startMinute: (nowMin + 1440 - 60) % 1440, endMinute: (nowMin + 60) % 1440 },
      },
    });
    await gw2.replayInboundSpool();
    await waitUntil(() => rows(spool)[0]?.status === 'done');
    expect(out.sends).toEqual([]);
    expect(held.rows.map((r) => r.text)).toEqual([expect.stringContaining(PLAIN)]);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    await gw2.sweepPendingDeliveries();
    await gw2.sweepPendingDeliveries();
    expect(out.sends).toHaveLength(1);
    expect(out.sends[0]).toContain(PLAIN);
    expect(held.rows).toEqual([]);
  });
});
