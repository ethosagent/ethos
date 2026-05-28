// AgentBridge — adapt AgentLoop's async-generator stream into an EventEmitter
// surface every UI surface (TUI, web, VS Code) can subscribe to identically.
//
// Per Phase 26 eng-review:
//   • finding 1.3 — concurrent sends are queued (FIFO, cap 10), not silently
//     dropped. Emits `queued` when held; `error: BUSY` when cap hit.
import { EventEmitter } from 'node:events';
export class AgentBridge extends EventEmitter {
  loop;
  controller = null;
  textBuffer = '';
  flushTimer = null;
  queue = [];
  queueCap;
  flushIntervalMs;
  turnTimeoutMs;
  // Clarify registrations are held on the bridge, not on the loop's
  // ClarifyBridge directly, so they survive `replaceLoop`: each rebuilt loop
  // gets a fresh ClarifyBridge that must be re-bound to the surface.
  clarifyPresenter;
  clarifyResolvedListeners = new Set();
  constructor(loop, options = {}) {
    super();
    this.loop = loop;
    this.queueCap = options.queueCap ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 16;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 5 * 60 * 1000;
  }
  get isRunning() {
    return this.controller !== null;
  }
  /**
   * The active loop's clarify bridge — reads through to the current loop so
   * `respond()` / `listPending()` follow `replaceLoop`. To register a
   * presenter or resolved-listener, use `setClarifyPresenter` /
   * `onClarifyResolved` instead so the registration survives `replaceLoop`.
   */
  get clarifyBridge() {
    return this.loop.clarifyBridge;
  }
  /**
   * Register how this surface presents a pending clarify. The registration is
   * remembered and re-applied to the new loop's ClarifyBridge on
   * `replaceLoop`, so clarify keeps working after a model switch.
   */
  setClarifyPresenter(presenter) {
    this.clarifyPresenter = presenter;
    this.loop.clarifyBridge?.setPresenter(presenter);
  }
  /**
   * Subscribe to clarify resolutions (answer / timeout / cancel) so the
   * surface can tear down its prompt. Re-applied across `replaceLoop`.
   * Returns an unsubscribe function.
   */
  onClarifyResolved(listener) {
    this.clarifyResolvedListeners.add(listener);
    const unsub = this.loop.clarifyBridge?.onResolved(listener);
    return () => {
      this.clarifyResolvedListeners.delete(listener);
      unsub?.();
    };
  }
  get queueDepth() {
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
  async send(input, opts) {
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
  abortTurn() {
    this.controller?.abort();
  }
  /** Drop any pending queued sends. Does not affect the in-flight turn. */
  clearQueue() {
    const dropped = this.queue.length;
    this.queue = [];
    return dropped;
  }
  /** Returns accumulated spend for the session key (0 if no spend recorded). */
  getSessionCost(sessionKey) {
    return this.loop.getSessionCost(sessionKey);
  }
  /** Resets the session spend counter — call after /new. */
  resetSessionCost(sessionKey) {
    this.loop.resetSessionCost(sessionKey);
  }
  /** Returns the budget cap for the personality (undefined = no cap). */
  getPersonalityBudgetCap(personalityId) {
    return this.loop.getPersonalityBudgetCap(personalityId);
  }
  /**
   * Swap the underlying AgentLoop on the next idle tick.
   * If a turn is in flight, it finishes with the old loop; subsequent turns
   * use the new one. Pending queued sends are cleared (they were addressed to
   * the old loop's context).
   */
  replaceLoop(newLoop) {
    this.loop = newLoop;
    this.clearQueue();
    // The new loop has a fresh ClarifyBridge with no presenter — re-bind the
    // surface's clarify registrations so they keep working after the swap.
    const cb = this.loop.clarifyBridge;
    if (!cb) return;
    if (this.clarifyPresenter) cb.setPresenter(this.clarifyPresenter);
    for (const listener of this.clarifyResolvedListeners) cb.onResolved(listener);
  }
  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------
  async runTurn(input, opts) {
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
      this.controller = null;
      this.emit('idle');
      const next = this.queue.shift();
      if (next) void this.runTurn(next.input, next.opts);
    }, this.turnTimeoutMs);
    try {
      for await (const event of this.loop.run(input, {
        ...opts,
        abortSignal: this.controller.signal,
      })) {
        switch (event.type) {
          case 'text_delta':
            this.bufferText(event.text);
            break;
          case 'done':
            clearTimeout(timeoutHandle);
            this.flushText();
            this.emit('done', event.text, event.turnCount);
            break;
          case 'thinking_delta':
            this.emit('thinking_delta', event.thinking);
            break;
          case 'tool_start':
            this.emit('tool_start', event.toolCallId, event.toolName, event.args);
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
            );
            break;
          case 'usage':
            this.emit('usage', event.inputTokens, event.outputTokens, event.estimatedCostUsd);
            break;
          case 'error':
            clearTimeout(timeoutHandle);
            this.flushText();
            this.emit('error', event.error, event.code);
            break;
          case 'run_start':
            this.emit('run_start', event.provider, event.model, event.source);
            break;
          case 'dry_run_summary':
            this.emit('dry_run_summary', event.plan, event.capped);
            break;
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
        this.controller = null;
        this.emit('idle');
        const next = this.queue.shift();
        if (next) void this.runTurn(next.input, next.opts);
      }
      // If timedOut: timeout handler already nulled controller, emitted idle, and
      // drained the queue. Don't double-process.
    }
  }
  bufferText(text) {
    this.textBuffer += text;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushText(), this.flushIntervalMs);
    }
  }
  flushText() {
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
