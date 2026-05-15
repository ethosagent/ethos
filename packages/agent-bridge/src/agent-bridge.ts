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
  RunOptions,
} from '@ethosagent/core';

export type BridgeOpts = Omit<RunOptions, 'abortSignal'>;

export interface BridgeOptions {
  /** Max concurrent-send queue depth before new sends are rejected with BUSY. */
  queueCap?: number;
  /** Text buffer flush cadence in ms (default 16, ~60fps). */
  flushIntervalMs?: number;
}

interface BridgeEventMap {
  text_delta: [text: string];
  thinking_delta: [thinking: string];
  tool_start: [toolCallId: string, toolName: string, args: unknown];
  tool_progress: [toolName: string, message: string, percent: number | undefined];
  tool_end: [
    toolCallId: string,
    toolName: string,
    ok: boolean,
    durationMs: number,
    result: string | undefined,
  ];
  usage: [inputTokens: number, outputTokens: number, estimatedCostUsd: number];
  error: [error: string, code: string];
  done: [text: string, turnCount: number];
  idle: [];
  queued: [input: string, queueDepth: number];
  /** Phase 5 — emitted once per turn with the resolved provider/model and routing source. */
  run_start: [
    provider: string,
    model: string,
    source: 'team-coordinator' | 'team-personality' | 'personality' | 'global',
  ];
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
  // Clarify registrations are held on the bridge, not on the loop's
  // ClarifyBridge directly, so they survive `replaceLoop`: each rebuilt loop
  // gets a fresh ClarifyBridge that must be re-bound to the surface.
  private clarifyPresenter: ClarifyPresenter | undefined;
  private readonly clarifyResolvedListeners = new Set<ClarifyResolvedListener>();

  constructor(loop: AgentLoop, options: BridgeOptions = {}) {
    super();
    this.loop = loop;
    this.queueCap = options.queueCap ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 16;
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
   * Register how this surface presents a pending clarify. The registration is
   * remembered and re-applied to the new loop's ClarifyBridge on
   * `replaceLoop`, so clarify keeps working after a model switch.
   */
  setClarifyPresenter(presenter: ClarifyPresenter): void {
    this.clarifyPresenter = presenter;
    this.loop.clarifyBridge?.setPresenter(presenter);
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

  /** Drop any pending queued sends. Does not affect the in-flight turn. */
  clearQueue(): number {
    const dropped = this.queue.length;
    this.queue = [];
    return dropped;
  }

  /** Returns accumulated spend for the session key (0 if no spend recorded). */
  getSessionCost(sessionKey: string): number {
    return this.loop.getSessionCost(sessionKey);
  }

  /** Resets the session spend counter — call after /new. */
  resetSessionCost(sessionKey: string): void {
    this.loop.resetSessionCost(sessionKey);
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
    if (this.clarifyPresenter) cb.setPresenter(this.clarifyPresenter);
    for (const listener of this.clarifyResolvedListeners) cb.onResolved(listener);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runTurn(input: string, opts: BridgeOpts): Promise<void> {
    this.controller = new AbortController();
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
            this.flushText();
            this.emit('error', event.error, event.code);
            break;
          case 'run_start':
            this.emit('run_start', event.provider, event.model, event.source);
            break;
        }
      }
    } catch (err) {
      this.flushText();
      if (!this.controller?.signal.aborted) {
        this.emit('error', err instanceof Error ? err.message : String(err), 'UNKNOWN');
      }
    } finally {
      this.flushText();
      this.controller = null;
      this.emit('idle');
      // Drain the queue head — async, doesn't block the original send promise.
      const next = this.queue.shift();
      if (next) {
        void this.runTurn(next.input, next.opts);
      }
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
