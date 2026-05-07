// Ch.6a — Watcher.
//
// Pure dispatch over the rule list. The host (CLI / web profile / cron)
// owns the consumer side: forwards events from `AgentLoop.run()` into
// `watcher.observe(event)`, and acts on the returned decision. Decisions
// are also recorded as `audit.watcher` events on the optional
// ObservabilityWriter so `ethos security audit` can surface them.

import type { ObservabilityWriter } from '@ethosagent/types';
import { defaultRules } from './rules';
import {
  makeInitialState,
  type WatcherDecision,
  type WatcherEvent,
  type WatcherRule,
  type WatcherState,
} from './types';

export interface WatcherOptions {
  rules?: WatcherRule[];
  observability?: ObservabilityWriter;
  /** Active trace id; threaded onto every audit.watcher event. */
  traceId?: string;
}

export class Watcher {
  private readonly rules: WatcherRule[];
  private readonly state: WatcherState = makeInitialState();
  private readonly observability?: ObservabilityWriter;
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
        this.observability?.recordEvent({
          ...(this.traceId ? { traceId: this.traceId } : {}),
          category: 'audit.watcher',
          severity: decision.action === 'terminate' ? 'critical' : 'warn',
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
