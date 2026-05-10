// Ch.6a — Watcher.
//
// Pure dispatch over the rule list. The host (CLI / web profile / cron)
// owns the consumer side: forwards events from `AgentLoop.run()` into
// `watcher.observe(event)`, and acts on the returned decision. Decisions
// are also surfaced via the optional WatcherObservability adapter so the
// host can record them (e.g. `ethos security audit`).

import { defaultRules } from './rules';
import {
  makeInitialState,
  type WatcherDecision,
  type WatcherEvent,
  type WatcherRule,
  type WatcherState,
} from './types';

/**
 * Minimal surface the watcher needs from an observability adapter. Defined
 * locally so this package depends only on `@ethosagent/types`. Any adapter
 * exposing this method shape (e.g. core's `EthosObservability`) is a fit.
 */
export interface WatcherObservability {
  recordWatcherDecision(opts: {
    traceId?: string;
    decision: 'pause' | 'force_approval' | 'terminate';
    code?: string;
    cause?: string;
  }): void;
}

export interface WatcherOptions {
  rules?: WatcherRule[];
  observability?: WatcherObservability;
  /** Active trace id; threaded onto every recorded watcher decision. */
  traceId?: string;
}

export class Watcher {
  private readonly rules: WatcherRule[];
  private readonly state: WatcherState = makeInitialState();
  private readonly observability?: WatcherObservability;
  private readonly traceId?: string;

  constructor(opts: WatcherOptions = {}) {
    this.rules = opts.rules ?? defaultRules();
    if (opts.observability) this.observability = opts.observability;
    if (opts.traceId) this.traceId = opts.traceId;
  }

  /** Drives the rule list against a single event. Returns the first
   *  non-allow decision, or `{ action: 'allow' }` if every rule
   *  passed. Records non-allow decisions in observability. */
  observe(event: WatcherEvent): WatcherDecision {
    for (const rule of this.rules) {
      const decision = rule.evaluate(event, this.state);
      if (decision && decision.action !== 'allow') {
        this.observability?.recordWatcherDecision({
          ...(this.traceId ? { traceId: this.traceId } : {}),
          decision: decision.action,
          code: decision.rule,
          cause: decision.reason,
        });
        return decision;
      }
    }
    return { action: 'allow' };
  }

  /** Resets per-turn counters. Call when a fresh user message arrives. */
  resetTurn(): void {
    for (const rule of this.rules) rule.onTurnReset?.(this.state);
  }
}
