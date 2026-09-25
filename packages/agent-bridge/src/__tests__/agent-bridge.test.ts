import type { AgentLoop } from '@ethosagent/core';
import { describe, expect, it, vi } from 'vitest';
import { AgentBridge, DEFAULT_TURN_TIMEOUT_MS } from '../agent-bridge';

async function* makeEventStream(
  events: { type: string; [k: string]: unknown }[],
): AsyncGenerator<unknown> {
  for (const e of events) {
    // Yield to microtasks between events so concurrent send() calls during
    // a turn actually see this.controller != null in the bridge.
    await Promise.resolve();
    yield e;
  }
}

describe('AgentBridge', () => {
  it('throttles text_delta to 16ms batches', async () => {
    vi.useFakeTimers();

    const loop = {
      run: vi.fn(() =>
        makeEventStream([
          { type: 'text_delta', text: 'Hello' },
          { type: 'text_delta', text: ' World' },
          { type: 'done', text: 'Hello World', turnCount: 1 },
        ]),
      ),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    const textDeltas: string[] = [];
    bridge.on('text_delta', (t) => textDeltas.push(t));

    const sendPromise = bridge.send('hi', {});

    // Before timer fires, no text_delta emitted (buffered)
    expect(textDeltas).toHaveLength(0);

    // Advance timer past 16ms — flush fires
    await vi.advanceTimersByTimeAsync(20);

    await sendPromise;

    // Both deltas should be flushed before done
    expect(textDeltas.join('')).toBe('Hello World');

    vi.useRealTimers();
  });

  it('emits done with full text after flush', async () => {
    const loop = {
      run: vi.fn(() =>
        makeEventStream([
          { type: 'text_delta', text: 'Hi' },
          { type: 'done', text: 'Hi', turnCount: 1 },
        ]),
      ),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    const doneTexts: string[] = [];
    bridge.on('done', (text) => doneTexts.push(text));

    await bridge.send('hello', {});

    expect(doneTexts).toEqual(['Hi']);
  });

  it('emits idle after turn regardless of error', async () => {
    const loop = {
      run: vi.fn(() => makeEventStream([{ type: 'error', error: 'boom', code: 'ERR' }])),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    let idleFired = false;
    bridge.on('idle', () => {
      idleFired = true;
    });
    bridge.on('error', () => {}); // prevent unhandled-error throw

    await bridge.send('x', {});
    expect(idleFired).toBe(true);
  });

  it('abortTurn cancels the running turn', async () => {
    let aborted = false;
    const loop = {
      run: vi.fn((_text: string, opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener('abort', () => {
          aborted = true;
        });
        return makeEventStream([]);
      }),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    const sendPromise = bridge.send('test', {});
    bridge.abortTurn();
    await sendPromise;

    expect(aborted).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Clarify registration survives replaceLoop
  // ---------------------------------------------------------------------------

  it('re-binds the clarify presenter onto the new loop after replaceLoop', () => {
    const makeFakeClarify = () => {
      const calls = { presenters: [] as unknown[], resolvedListeners: 0 };
      return {
        calls,
        bridge: {
          registerPresenter: (_surfaceType: unknown, p: unknown) => calls.presenters.push(p),
          onResolved: () => {
            calls.resolvedListeners += 1;
            return () => {};
          },
        },
      };
    };

    const c1 = makeFakeClarify();
    const loop1 = { clarifyBridge: c1.bridge } as unknown as AgentLoop;
    const bridge = new AgentBridge(loop1);

    const presenter = vi.fn();
    bridge.setClarifyPresenter('tui', presenter);
    bridge.onClarifyResolved(() => {});
    expect(c1.calls.presenters).toEqual([presenter]);
    expect(c1.calls.resolvedListeners).toBe(1);

    // A model switch rebuilds the loop with a fresh ClarifyBridge.
    const c2 = makeFakeClarify();
    const loop2 = { clarifyBridge: c2.bridge } as unknown as AgentLoop;
    bridge.replaceLoop(loop2);

    // The new loop's ClarifyBridge gets the same presenter + listener, so
    // clarify keeps working instead of degrading to CLARIFY_NO_SURFACE.
    expect(c2.calls.presenters).toEqual([presenter]);
    expect(c2.calls.resolvedListeners).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Concurrent-send queue (eng-review finding 1.3)
  // ---------------------------------------------------------------------------

  it('queues a second send while a turn is running and processes both in order', async () => {
    const calls: string[] = [];
    const loop = {
      run: vi.fn((text: string) => {
        calls.push(text);
        return makeEventStream([{ type: 'done', text, turnCount: 1 }]);
      }),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    const queuedFor: string[] = [];
    bridge.on('queued', (input) => queuedFor.push(input));

    // Wait until two `idle` events fire (one per turn).
    let idleCount = 0;
    const bothIdle = new Promise<void>((resolve) => {
      bridge.on('idle', () => {
        idleCount += 1;
        if (idleCount === 2) resolve();
      });
    });

    void bridge.send('first', {});
    void bridge.send('second', {});

    await bothIdle;

    expect(loop.run).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['first', 'second']);
    expect(queuedFor).toEqual(['second']);
  });

  it('rejects with BUSY when the queue is at capacity', async () => {
    const loop = {
      run: vi.fn(() => makeEventStream([{ type: 'done', text: '', turnCount: 1 }])),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop, { queueCap: 1 });
    const errors: Array<{ msg: string; code: string }> = [];
    bridge.on('error', (msg, code) => errors.push({ msg, code }));
    bridge.on('queued', () => {});

    void bridge.send('first', {}); // running
    void bridge.send('second', {}); // queued (cap=1)
    void bridge.send('third', {}); // rejected (cap exceeded)

    // wait one microtask round so the synchronous queue checks above resolve
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('BUSY');
  });

  it('clearQueue drops pending sends without affecting the in-flight turn', async () => {
    const calls: string[] = [];
    const loop = {
      run: vi.fn((text: string) => {
        calls.push(text);
        return makeEventStream([{ type: 'done', text, turnCount: 1 }]);
      }),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);

    let idleSeen = 0;
    const firstIdle = new Promise<void>((resolve) => {
      bridge.on('idle', () => {
        idleSeen += 1;
        if (idleSeen === 1) resolve();
      });
    });

    void bridge.send('first', {});
    void bridge.send('queued-but-dropped', {});

    expect(bridge.queueDepth).toBe(1);
    const dropped = bridge.clearQueue();
    expect(dropped).toBe(1);
    expect(bridge.queueDepth).toBe(0);

    await firstIdle;

    // Only the first turn ran; queued one was dropped before it could fire.
    expect(loop.run).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['first']);
  });
});

// F06 follow-up — a host that replaces the bridge's loop (the TUI `/model`
// switch) must know when the replaced loop has no turn left on it.
describe('AgentBridge.whenIdle (F06)', () => {
  it('resolves at once when idle, and after the running turn ends otherwise', async () => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    const loop = {
      async *run() {
        await gate;
        yield { type: 'done', text: 'ok', turnCount: 1 };
      },
    } as unknown as AgentLoop;
    const bridge = new AgentBridge(loop);
    await bridge.whenIdle();

    const turn = bridge.send('x', { sessionKey: 's' });
    let idle = false;
    const waiting = bridge.whenIdle().then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(idle).toBe(false);
    finish?.();
    await turn;
    await waiting;
    expect(idle).toBe(true);
  });
});

// F06 follow-up — the stall guard gives up on a turn that stops producing
// events: it emits `idle` so the UI unblocks, but the abandoned turn is still
// running on the loop. `whenIdle()` (what a host waits on before disposing the
// loop) must mean every turn actually SETTLED, not that the UI moved on.
describe('AgentBridge.whenIdle waits for an abandoned turn to settle (F06)', () => {
  it('does not resolve on the stall guard’s idle while the turn still runs', async () => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    const loop = {
      async *run() {
        // Ignores its abort — a tool call that never checks the signal.
        await gate;
        yield { type: 'done', text: 'late', turnCount: 1 };
      },
    } as unknown as AgentLoop;
    const bridge = new AgentBridge(loop, { turnTimeoutMs: 20 });
    const idleEvents: number[] = [];
    bridge.on('idle', () => idleEvents.push(Date.now()));
    bridge.on('error', () => {});

    void bridge.send('x', { sessionKey: 's' });
    await new Promise((r) => setTimeout(r, 60));
    // The stall guard fired: the UI sees idle, isRunning is false…
    expect(idleEvents.length).toBe(1);
    expect(bridge.isRunning).toBe(false);

    // …but the turn has not settled, so neither has whenIdle.
    let settled = false;
    const waiting = bridge.whenIdle().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    finish?.();
    await waiting;
    expect(settled).toBe(true);
  });

  it('default turn cap is DEFAULT_TURN_TIMEOUT_MS (20 minutes) when no override is passed', () => {
    // Pins the resolved field rather than exercising the timer: this is a wall
    // clock on the whole turn, so exercising the real default would mean a
    // 20-minute test. Every production caller (apps/tui, web-api ChatService)
    // constructs the bridge with no `turnTimeoutMs`, so this IS their cap.
    expect(DEFAULT_TURN_TIMEOUT_MS).toBe(1_200_000);

    const loop = {
      async *run() {
        yield { type: 'done', text: 'ok', turnCount: 1 };
      },
    } as unknown as AgentLoop;

    const defaulted = new AgentBridge(loop);
    expect((defaulted as unknown as { turnTimeoutMs: number }).turnTimeoutMs).toBe(
      DEFAULT_TURN_TIMEOUT_MS,
    );

    const overridden = new AgentBridge(loop, { turnTimeoutMs: 1_000 });
    expect((overridden as unknown as { turnTimeoutMs: number }).turnTimeoutMs).toBe(1_000);
  });

  it('forwards credential_required without its type tag (openclaw-9.5 item 1)', async () => {
    const loop = {
      run: vi.fn(() =>
        makeEventStream([
          {
            type: 'credential_required',
            pluginId: 'weather',
            credentialKey: 'API_KEY',
            kind: 'api_key',
            label: 'Weather API key',
            sessionKey: 'tui:x',
            pendingUserMessage: 'forecast?',
          },
          { type: 'done', text: '', turnCount: 0 },
        ]),
      ),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    const seen: unknown[] = [];
    bridge.on('credential_required', (req) => seen.push(req));
    await bridge.send('forecast?', { credentialPrompt: true });

    expect(seen).toEqual([
      {
        pluginId: 'weather',
        credentialKey: 'API_KEY',
        kind: 'api_key',
        label: 'Weather API key',
        sessionKey: 'tui:x',
        pendingUserMessage: 'forecast?',
      },
    ]);
    expect(loop.run).toHaveBeenCalledWith(
      'forecast?',
      expect.objectContaining({ credentialPrompt: true }),
    );
  });
  it('forwards decision events without their type tag, including one after done (§15.2, PD17)', async () => {
    const settled = {
      id: 'd1',
      phase: 'settled' as const,
      site: 'injection' as const,
      provider: 'typesafe',
      mode: 'shadow' as const,
      outcome: 'ok' as const,
      verdict: 'clean',
      latencyMs: 30,
      personalityId: 'p',
      toolCallId: 'call_1',
    };
    const loop = {
      run: vi.fn(() =>
        makeEventStream([
          { type: 'text_delta', text: 'hi' },
          { type: 'done', text: 'hi', turnCount: 1 },
          { type: 'decision', ...settled },
        ]),
      ),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    const seen: unknown[] = [];
    bridge.on('decision', (d) => seen.push(d));
    await bridge.send('hi', {});

    expect(seen).toEqual([settled]);
  });
});
