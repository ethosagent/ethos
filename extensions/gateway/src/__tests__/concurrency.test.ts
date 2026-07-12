import type { AgentLoop } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SYSTEM_BUSY_MARKER = 'system is busy';

async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

function stubAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id: 'test',
    displayName: 'Test',
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
    ...overrides,
  };
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'test',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
    ...overrides,
  };
}

/**
 * A loop whose `run()` parks on a gate until released, so tests can observe
 * how many turns execute concurrently (peak) and how many have started.
 */
function gatedLoop() {
  const state = { started: 0, active: 0, peak: 0 };
  const gates: Array<() => void> = [];
  const loop = {
    run: vi.fn(async function* () {
      state.started++;
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      try {
        await new Promise<void>((res) => gates.push(res));
      } finally {
        state.active--;
      }
      yield { type: 'text_delta' as const, text: 'reply' };
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
  return {
    loop: loop as unknown as AgentLoop,
    state,
    releaseAll: () => {
      while (gates.length) gates.shift()?.();
    },
    gateCount: () => gates.length,
  };
}

/** Drive all pending handleMessage promises to completion by flushing gates. */
async function drain(gate: { releaseAll: () => void }, handles: Promise<unknown>[]): Promise<void> {
  const done = Promise.allSettled(handles);
  const t = setInterval(() => gate.releaseAll(), 1);
  await done;
  clearInterval(t);
}

function makeGateway(g: ReturnType<typeof gatedLoop>, opts: Record<string, unknown> = {}) {
  return new Gateway({
    bots: [{ botKey: 'b1', loop: g.loop, binding: { type: 'personality', name: 'default' } }],
    clarifySweepIntervalMs: 0,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// P5.3 — global concurrency semaphore
// ---------------------------------------------------------------------------

describe('Gateway — global concurrency limit (P5.3)', () => {
  it('runs at most maxConcurrentSessions turns concurrently under a burst', async () => {
    const g = gatedLoop();
    const gw = makeGateway(g, { maxConcurrentSessions: 2 });
    const adapter = stubAdapter();

    // Burst of 5 distinct lanes (distinct chatIds → distinct lanes).
    const handles: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      handles.push(gw.handleMessage(makeMessage({ chatId: `chat-${i}` }), adapter));
    }

    // Exactly 2 acquire a slot and start; the other 3 are parked on the
    // semaphore (run() never called) — so started stalls at 2.
    await waitUntil(() => g.state.started === 2);
    // Hold long enough to prove it does not creep past the cap.
    await new Promise((r) => setTimeout(r, 30));
    expect(g.state.started).toBe(2);
    expect(g.state.peak).toBe(2);

    // Let everything finish; the cap must never have been exceeded.
    await drain(g, handles);
    expect(g.state.started).toBe(5);
    expect(g.state.peak).toBe(2);
  });

  it('unset maxConcurrentSessions preserves unbounded concurrency', async () => {
    const g = gatedLoop();
    const gw = makeGateway(g); // no maxConcurrentSessions
    const adapter = stubAdapter();

    const handles: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      handles.push(gw.handleMessage(makeMessage({ chatId: `chat-${i}` }), adapter));
    }

    await waitUntil(() => g.state.started === 4);
    expect(g.state.peak).toBe(4); // all four run at once — no limit

    await drain(g, handles);
  });
});

// ---------------------------------------------------------------------------
// P5.3 — per-lane queue cap + typed busy rejection
// ---------------------------------------------------------------------------

describe('Gateway — per-lane queue cap (P5.3)', () => {
  it('rejects with a typed busy reply when the lane queue is full under saturation', async () => {
    const g = gatedLoop();
    const gw = makeGateway(g, { maxConcurrentSessions: 1, maxLaneQueue: 1 });
    const adapterA = stubAdapter();
    const adapterB = stubAdapter();

    // Lane A takes the only global slot and parks inside run().
    const hA = gw.handleMessage(makeMessage({ chatId: 'A', text: 'go' }), adapterA);
    await waitUntil(() => g.state.started === 1);

    // Lane B's first message parks on the semaphore (slot held by A). Its lane
    // is now "processing" (depth 1) but run() has not started.
    const hB1 = gw.handleMessage(makeMessage({ chatId: 'B', text: 'one' }), adapterB);
    await waitUntil(() => g.gateCount() === 1); // only A is inside run()
    // give B1 a tick to reach the semaphore wait and mark the lane processing
    await new Promise((r) => setTimeout(r, 10));

    // Lane B's second message: global saturated AND lane depth (1) >= cap (1)
    // → typed busy rejection, delivered via the normal send path.
    await gw.handleMessage(makeMessage({ chatId: 'B', text: 'two' }), adapterB);

    const busyCall = (adapterB.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[1]?.text === 'string' && c[1].text.toLowerCase().includes(SYSTEM_BUSY_MARKER),
    );
    expect(busyCall).toBeDefined();
    // run() was never invoked for the rejected message — still just A running.
    expect(g.state.started).toBe(1);

    await drain(g, [hA, hB1]);
  });

  it('does not reject when the global budget is unbounded (never saturates)', async () => {
    const g = gatedLoop();
    const gw = makeGateway(g, { maxLaneQueue: 1 }); // no maxConcurrentSessions
    const adapter = stubAdapter();

    const handles = [
      gw.handleMessage(makeMessage({ chatId: 'A', text: 'one' }), adapter),
      gw.handleMessage(makeMessage({ chatId: 'A', text: 'two' }), adapter),
    ];
    await new Promise((r) => setTimeout(r, 20));

    const busyCall = (adapter.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[1]?.text === 'string' && c[1].text.toLowerCase().includes(SYSTEM_BUSY_MARKER),
    );
    expect(busyCall).toBeUndefined();

    await drain(g, handles);
  });
});

// ---------------------------------------------------------------------------
// P5.3 — slot release on completion / error / abort (no starvation / leak)
// ---------------------------------------------------------------------------

describe('Gateway — semaphore slot release (P5.3)', () => {
  it('frees the slot after a turn completes so the next turn can run', async () => {
    const g = gatedLoop();
    const gw = makeGateway(g, { maxConcurrentSessions: 1 });
    const adapter = stubAdapter();

    await drain(g, [gw.handleMessage(makeMessage({ chatId: 'A' }), adapter)]);
    expect(g.state.started).toBe(1);

    // Second turn only runs if the slot was released.
    await drain(g, [gw.handleMessage(makeMessage({ chatId: 'B' }), adapter)]);
    expect(g.state.started).toBe(2);
    expect(g.state.peak).toBe(1);
  });

  it('frees the slot after a turn errors', async () => {
    const state = { started: 0 };
    const errorLoop = {
      run: vi.fn(async function* () {
        state.started++;
        yield { type: 'error' as const, error: 'boom', code: 'E' };
      }),
      hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    };
    const gw = new Gateway({
      bots: [
        {
          botKey: 'b1',
          loop: errorLoop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      maxConcurrentSessions: 1,
      clarifySweepIntervalMs: 0,
    });
    const adapter = stubAdapter();

    await gw.handleMessage(makeMessage({ chatId: 'A' }), adapter);
    await gw.handleMessage(makeMessage({ chatId: 'B' }), adapter);
    // Both ran → the errored first turn released its slot.
    expect(state.started).toBe(2);
  });

  it('does not leak a slot when a waiting turn is aborted', async () => {
    const g = gatedLoop();
    const gw = makeGateway(g, { maxConcurrentSessions: 1 });
    const adapterA = stubAdapter();
    const adapterB = stubAdapter();
    const adapterC = stubAdapter();

    // A holds the only slot.
    const hA = gw.handleMessage(makeMessage({ chatId: 'A', text: 'go' }), adapterA);
    await waitUntil(() => g.state.started === 1);

    // B parks on the semaphore.
    const hB = gw.handleMessage(makeMessage({ chatId: 'B', text: 'one' }), adapterB);
    await new Promise((r) => setTimeout(r, 10));
    expect(g.state.started).toBe(1);

    // Abort B while it waits — its acquire must resolve without holding a permit.
    await gw.handleMessage(makeMessage({ chatId: 'B', text: '/stop' }), adapterB);
    await new Promise((r) => setTimeout(r, 10));

    // Release A → the freed permit must be available to a fresh lane C (proving
    // the aborted waiter neither held nor swallowed a permit).
    g.releaseAll();
    await hB.catch(() => {}); // aborted lane rejects
    const hC = gw.handleMessage(makeMessage({ chatId: 'C', text: 'go' }), adapterC);
    await waitUntil(() => g.state.started === 2);

    await drain(g, [hA, hC]);
    expect(g.state.started).toBe(2);
    expect(g.state.peak).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P5.4 — dedup drop observability wiring
// ---------------------------------------------------------------------------

describe('Gateway — dedup drop observability (P5.4)', () => {
  it('records a gateway.dedup_drop event when an identical outbound is suppressed', async () => {
    const g = gatedLoop();
    const blocks: { code?: string; details?: Record<string, unknown> }[] = [];
    const observability = {
      recordSafetyBlock: (o: { code?: string; details?: Record<string, unknown> }) =>
        blocks.push(o),
      recordChannelAllow: () => {},
      recordChannelDeny: () => {},
    };
    const gw = makeGateway(g, { observability });
    const adapter = stubAdapter();

    // Same lane, two turns → identical 'reply' response the second time is
    // suppressed by the outbound dedup cache, emitting one drop event.
    await drain(g, [gw.handleMessage(makeMessage({ chatId: 'A', text: 'one' }), adapter)]);
    await drain(g, [gw.handleMessage(makeMessage({ chatId: 'A', text: 'two' }), adapter)]);

    const dropEvents = blocks.filter((b) => b.code === 'gateway.dedup_drop');
    expect(dropEvents).toHaveLength(1);
    expect(dropEvents[0]?.details).toMatchObject({ contentLength: 'reply'.length });
    expect(typeof dropEvents[0]?.details?.contentHash).toBe('string');
    // Only one 'reply' should have reached the adapter (the dup was dropped).
    const replySends = (adapter.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1]?.text === 'reply',
    );
    expect(replySends).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P5.5 — tool-call status machinery deleted: tool events never surface to channel
// ---------------------------------------------------------------------------

describe('Gateway — tool lifecycle events never surface to the channel (P5.5)', () => {
  it('does not edit a channel status message on tool_start / tool_end', async () => {
    const toolLoop = {
      run: vi.fn(async function* () {
        yield { type: 'tool_start' as const, toolCallId: 't1', toolName: 'read_file', args: {} };
        yield {
          type: 'tool_end' as const,
          toolCallId: 't1',
          toolName: 'read_file',
          ok: true,
          durationMs: 12,
        };
        yield { type: 'text_delta' as const, text: 'done' };
        yield { type: 'done' as const, text: 'done', turnCount: 1 };
      }),
      hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    };
    const editMessage = vi.fn().mockResolvedValue({ ok: true });
    const adapter = stubAdapter({
      editMessage,
      canEditMessage: true,
    });
    const gw = new Gateway({
      bots: [
        {
          botKey: 'b1',
          loop: toolLoop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      clarifySweepIntervalMs: 0,
    });

    await gw.handleMessage(makeMessage({ chatId: 'A' }), adapter);

    // Internal tool lifecycle must NOT be surfaced as an editable status card.
    expect(editMessage).not.toHaveBeenCalled();
    // The actual reply still went out.
    expect(
      (adapter.send as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[1]?.text === 'done'),
    ).toBe(true);
  });
});
