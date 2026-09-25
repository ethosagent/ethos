// AgentBridge — adapt AgentLoop's async-generator stream into an EventEmitter
// surface every UI surface (TUI, web, VS Code) can subscribe to identically.
//
// Per Phase 26 eng-review:
//   • finding 1.3 — concurrent sends are queued (FIFO, cap 10), not silently
//     dropped. Emits `queued` when held; `error: BUSY` when cap hit.

import { EventEmitter } from 'node:events';
import type {
  AgentLoop,
  ClarifyPresenter,
  ClarifyResolvedListener,
  DryRunToolPlan,
  RunOptions,
} from '@ethosagent/core';
import type {
  AgentEvent,
  ClarifySurfaceType,
  ModelDeviation,
  ModelResolutionSource,
} from '@ethosagent/types';
import { InMemorySteerSink } from './in-memory-steer-sink';

export type BridgeOpts = Omit<RunOptions, 'abortSignal'>;

/**
 * Default whole-turn stall guard: 20 minutes.
 *
 * Unlike the loop's `DEFAULT_STREAMING_TIMEOUT_MS`, this is NOT an idle timer —
 * it is a wall clock on the entire turn, armed once in `runTurnBody` and
 * cleared only when the turn settles. A turn that is making steady progress is
 * abandoned at this mark regardless.
 *
 * What the longer cap costs: a stuck turn holds its lane twice as long. The
 * bridge serialises turns per session, so between the stall and the guard
 * firing, every queued send for that session waits, `isRunning` stays true, and
 * the UI shows a busy agent; at `queueCap` further sends are rejected with BUSY.
 * The abandoned turn also keeps running on the loop after `idle` is emitted (see
 * `turnsInFlight`), so its token spend is not bounded by this guard either.
 * Raising it from 10 to 20 minutes doubles all of that. It buys back the
 * opposite failure, which was the common one: a legitimately long turn — a
 * reasoning model plus a slow tool chain — reported to the user as a timeout
 * while it was still working.
 *
 * Nothing in the repo overrides it: `apps/tui/src/index.ts` and
 * `apps/web-api/src/features/chat/service.ts` both construct `AgentBridge` with
 * no `turnTimeoutMs`, and the only caller that passes one is
 * `__tests__/agent-bridge.test.ts` (a 20ms value, to exercise the guard). The
 * `/v1/chat/completions` route uses no bridge at all and so has no turn cap.
 * Pinned by the 'default turn cap' case in `__tests__/agent-bridge.test.ts`.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 1_200_000;

export interface BridgeOptions {
  /** Max concurrent-send queue depth before new sends are rejected with BUSY. */
  queueCap?: number;
  /** Text buffer flush cadence in ms (default 16, ~60fps). */
  flushIntervalMs?: number;
  /** Max ms to wait for a turn to complete before emitting TIMEOUT. Absent →
   *  `DEFAULT_TURN_TIMEOUT_MS`. */
  turnTimeoutMs?: number;
}

interface BridgeEventMap {
  text_delta: [text: string];
  thinking_delta: [thinking: string];
  // Lane E (tools-as-code-api) — the trailing `audience` mirrors the optional
  // AgentEvent field: 'internal' marks in-script inner calls that user-facing
  // consumers must not render. Trailing/optional so 3-arg handlers keep working.
  tool_start: [
    toolCallId: string,
    toolName: string,
    args: unknown,
    audience: 'internal' | 'user' | 'dashboard' | undefined,
  ];
  tool_progress: [toolName: string, message: string, percent: number | undefined];
  tool_end: [
    toolCallId: string,
    toolName: string,
    ok: boolean,
    durationMs: number,
    result: string | undefined,
    structured: Record<string, unknown> | undefined,
    audience: 'internal' | 'user' | 'dashboard' | undefined,
  ];
  usage: [inputTokens: number, outputTokens: number, estimatedCostUsd: number];
  /** S4/U1 — an early safety stop (budget or watcher). Forwarded whole; a
   *  surface renders it with `haltNotice` (@ethosagent/core). A `done` follows. */
  halt: [halt: Omit<Extract<AgentEvent, { type: 'halt' }>, 'type'>];
  error: [error: string, code: string];
  // B3 — the trailing `traceId` mirrors the optional AgentEvent field: the
  // turn's observability trace id, or undefined when no adapter is wired.
  // Trailing/optional so existing 2-arg handlers keep working.
  done: [text: string, turnCount: number, traceId: string | undefined];
  idle: [];
  queued: [input: string, queueDepth: number];
  /** Phase 5 — emitted once per turn with the resolved provider/model and routing source.
   *  B3 — the trailing `traceId` is the turn identity; see `done` above.
   *  T1.15a — `source` is the seven-label `ModelResolutionSource` (`'global'`
   *  renamed `'default'`), and `deviation` is APPENDED as the last slot so a
   *  handler written against the four-arg signature keeps working. */
  run_start: [
    provider: string,
    model: string,
    source: ModelResolutionSource,
    traceId: string | undefined,
    deviation?: ModelDeviation,
  ];
  /** Emitted when dryRun is active — carries the planned tool calls. */
  dry_run_summary: [plan: DryRunToolPlan[], capped: number];
  /** openclaw-9.5 item 1 — the turn was refused pre-turn for a missing plugin
   *  credential (only when the send passed `credentialPrompt: true`). The
   *  surface collects the value masked, stores it with
   *  `PluginLoader.setCredential`, and resends `pendingUserMessage`. A `done`
   *  with empty text follows, as for any refused turn. */
  credential_required: [
    request: Omit<Extract<AgentEvent, { type: 'credential_required' }>, 'type'>,
  ];
  /** plan decision-provider-personality §15.2 — a decision site ran for this
   *  turn. Forwarded whole (it carries summaries only, K13); a late shadow row
   *  can arrive after `done`, which is why `runTurn` drains to exhaustion. */
  decision: [decision: Omit<Extract<AgentEvent, { type: 'decision' }>, 'type'>];
}

interface QueuedSend {
  input: string;
  opts: BridgeOpts;
}

export class AgentBridge extends EventEmitter<BridgeEventMap> {
  private loop: AgentLoop;
  private controller: AbortController | null = null;
  private textBuffer = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: QueuedSend[] = [];
  private readonly queueCap: number;
  private readonly flushIntervalMs: number;
  private readonly turnTimeoutMs: number;
  // Clarify registrations are held on the bridge, not on the loop's
  // ClarifyBridge directly, so they survive `replaceLoop`: each rebuilt loop
  // gets a fresh ClarifyBridge that must be re-bound to the surface.
  private clarifyPresenter:
    | { surfaceType: ClarifySurfaceType; presenter: ClarifyPresenter }
    | undefined;
  private readonly clarifyResolvedListeners = new Set<ClarifyResolvedListener>();
  private activeSink: InMemorySteerSink | null = null;
  /**
   * One entry per `runTurn` that has not SETTLED — including a turn the stall
   * guard abandoned, which keeps running on the loop after `idle` was emitted.
   * What `whenIdle()` waits on; `isRunning` (the UI's view) does not.
   */
  private readonly turnsInFlight = new Set<Promise<void>>();

  constructor(loop: AgentLoop, options: BridgeOptions = {}) {
    super();
    this.loop = loop;
    this.queueCap = options.queueCap ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 16;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  }

  get isRunning(): boolean {
    return this.controller !== null;
  }

  /**
   * The active loop's clarify bridge — reads through to the current loop so
   * `respond()` / `listPending()` follow `replaceLoop`. To register a
   * presenter or resolved-listener, use `setClarifyPresenter` /
   * `onClarifyResolved` instead so the registration survives `replaceLoop`.
   */
  get clarifyBridge(): AgentLoop['clarifyBridge'] {
    return this.loop.clarifyBridge;
  }

  /**
   * Register how this surface presents a pending clarify for its own surface
   * type (G2). The registration is remembered and re-applied to the new
   * loop's ClarifyBridge on `replaceLoop`, so clarify keeps working after a
   * model switch.
   */
  setClarifyPresenter(surfaceType: ClarifySurfaceType, presenter: ClarifyPresenter): void {
    this.clarifyPresenter = { surfaceType, presenter };
    this.loop.clarifyBridge?.registerPresenter(surfaceType, presenter);
  }

  /**
   * Subscribe to clarify resolutions (answer / timeout / cancel) so the
   * surface can tear down its prompt. Re-applied across `replaceLoop`.
   * Returns an unsubscribe function.
   */
  onClarifyResolved(listener: ClarifyResolvedListener): () => void {
    this.clarifyResolvedListeners.add(listener);
    const unsub = this.loop.clarifyBridge?.onResolved(listener);
    return () => {
      this.clarifyResolvedListeners.delete(listener);
      unsub?.();
    };
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  /**
   * Send an input. If a turn is already running, the input is queued (FIFO)
   * and processed when the current turn ends. If the queue is at capacity,
   * an `error: BUSY` event fires and the input is dropped.
   *
   * Returns when the *initial* turn finishes — queued turns continue
   * asynchronously and surface state via `queued` / `idle` events.
   */
  async send(input: string, opts: BridgeOpts): Promise<void> {
    if (this.controller) {
      if (this.queue.length >= this.queueCap) {
        this.emit('error', `Queue full (cap ${this.queueCap}) — drop input`, 'BUSY');
        return;
      }
      this.queue.push({ input, opts });
      this.emit('queued', input, this.queue.length);
      return;
    }
    await this.runTurn(input, opts);
  }

  abortTurn(): void {
    this.controller?.abort();
  }

  /**
   * Resolves once no turn is running — at once when idle. After `replaceLoop`
   * the only turn that can still be running is the replaced loop's, so this is
   * when a host may release that loop's runtime (F06; the TUI's `/model`
   * switch, apps/tui/src/loop-switch.ts).
   */
  async whenIdle(): Promise<void> {
    // Not the `idle` event: the stall guard emits it for a turn it abandons
    // while that turn is still running, and a host that disposes the loop at
    // that point pulls its stores out from under it. A queued turn starts
    // before the one ahead of it leaves the set, so the loop only ends once
    // nothing is left to run. Pinned by __tests__/agent-bridge.test.ts.
    while (this.turnsInFlight.size > 0) {
      await Promise.all([...this.turnsInFlight]);
    }
  }

  /** Drop any pending queued sends. Does not affect the in-flight turn. */
  clearQueue(): number {
    const dropped = this.queue.length;
    this.queue = [];
    return dropped;
  }

  steer(text: string): boolean {
    if (!this.activeSink) return false;
    return this.activeSink.push(text);
  }

  /** Returns accumulated spend for the session key (0 if no spend recorded). */
  getSessionCost(sessionKey: string): number {
    return this.loop.getSessionCost(sessionKey);
  }

  /** Resets the session spend counter — call after /new. */
  resetSessionCost(sessionKey: string): void {
    this.loop.resetSessionCost(sessionKey);
  }

  /** Manual `/compact` — force a compaction outside a turn (delegates to the loop). */
  compact(
    sessionKey: string,
    opts?: { instructions?: string; personalityId?: string },
  ): ReturnType<AgentLoop['compact']> {
    return this.loop.compact(sessionKey, opts);
  }

  /** Returns the budget cap for the personality (undefined = no cap). */
  getPersonalityBudgetCap(personalityId?: string): number | undefined {
    return this.loop.getPersonalityBudgetCap(personalityId);
  }

  /**
   * Swap the underlying AgentLoop on the next idle tick.
   * If a turn is in flight, it finishes with the old loop; subsequent turns
   * use the new one. Pending queued sends are cleared (they were addressed to
   * the old loop's context).
   */
  replaceLoop(newLoop: AgentLoop): void {
    this.loop = newLoop;
    this.clearQueue();
    // The new loop has a fresh ClarifyBridge with no presenter — re-bind the
    // surface's clarify registrations so they keep working after the swap.
    const cb = this.loop.clarifyBridge;
    if (!cb) return;
    if (this.clarifyPresenter) {
      cb.registerPresenter(this.clarifyPresenter.surfaceType, this.clarifyPresenter.presenter);
    }
    for (const listener of this.clarifyResolvedListeners) cb.onResolved(listener);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runTurn(input: string, opts: BridgeOpts): Promise<void> {
    let settle: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.turnsInFlight.add(settled);
    try {
      await this.runTurnBody(input, opts);
    } finally {
      this.turnsInFlight.delete(settled);
      settle?.();
    }
  }

  private async runTurnBody(input: string, opts: BridgeOpts): Promise<void> {
    this.controller = new AbortController();
    let timedOut = false;

    // Stall guard: if no done/error arrives within turnTimeoutMs, emit an error
    // from outside the suspended for-await loop and unblock the bridge.
    const timeoutHandle = setTimeout(() => {
      if (!this.controller) return; // turn already finished normally
      timedOut = true;
      this.flushText();
      this.emit(
        'error',
        `Agent did not complete within ${Math.round(this.turnTimeoutMs / 60_000)} minutes — turn abandoned.`,
        'TIMEOUT',
      );
      this.controller.abort();
      this.activeSink = null;
      this.controller = null;
      this.emit('idle');
      const next = this.queue.shift();
      if (next) void this.runTurn(next.input, next.opts);
    }, this.turnTimeoutMs);

    const steerSink = new InMemorySteerSink();
    this.activeSink = steerSink;

    try {
      for await (const event of this.loop.run(input, {
        ...opts,
        abortSignal: this.controller.signal,
        steerSink,
      })) {
        switch (event.type) {
          case 'text_delta':
            this.bufferText(event.text);
            break;
          case 'done':
            clearTimeout(timeoutHandle);
            this.flushText();
            this.emit('done', event.text, event.turnCount, event.traceId);
            break;
          case 'thinking_delta':
            this.emit('thinking_delta', event.thinking);
            break;
          case 'tool_start':
            this.emit('tool_start', event.toolCallId, event.toolName, event.args, event.audience);
            break;
          case 'tool_progress':
            this.emit('tool_progress', event.toolName, event.message, event.percent);
            break;
          case 'tool_end':
            this.emit(
              'tool_end',
              event.toolCallId,
              event.toolName,
              event.ok,
              event.durationMs,
              event.result,
              event.structured,
              event.audience,
            );
            break;
          case 'usage':
            this.emit('usage', event.inputTokens, event.outputTokens, event.estimatedCostUsd);
            break;
          case 'halt': {
            const { type: _type, ...halt } = event;
            this.emit('halt', halt);
            break;
          }
          case 'error':
            clearTimeout(timeoutHandle);
            this.flushText();
            this.emit('error', event.error, event.code);
            break;
          case 'run_start':
            this.emit(
              'run_start',
              event.provider,
              event.model,
              event.source,
              event.traceId,
              event.deviation,
            );
            break;
          case 'dry_run_summary':
            this.emit('dry_run_summary', event.plan, event.capped);
            break;
          case 'credential_required': {
            const { type: _type, ...request } = event;
            this.emit('credential_required', request);
            break;
          }
          case 'decision': {
            const { type: _type, ...decision } = event;
            this.emit('decision', decision);
            break;
          }
        }
      }
    } catch (err) {
      clearTimeout(timeoutHandle);
      this.flushText();
      if (timedOut) {
        // Timeout handler already emitted the error and cleaned up bridge state.
      } else if (!this.controller?.signal.aborted) {
        this.emit('error', err instanceof Error ? err.message : String(err), 'UNKNOWN');
      }
      // user-initiated abort: stay silent (deliberate behavior, not an error).
    } finally {
      clearTimeout(timeoutHandle);
      if (!timedOut) {
        // Normal path: timeout handler didn't fire, do normal cleanup.
        this.flushText();
        this.activeSink = null;
        this.controller = null;
        this.emit('idle');
        const next = this.queue.shift();
        if (next) void this.runTurn(next.input, next.opts);
      }
      // If timedOut: timeout handler already nulled controller, emitted idle, and
      // drained the queue. Don't double-process.
    }
  }

  private bufferText(text: string): void {
    this.textBuffer += text;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushText(), this.flushIntervalMs);
    }
  }

  private flushText(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.textBuffer) {
      this.emit('text_delta', this.textBuffer);
      this.textBuffer = '';
    }
  }
}
