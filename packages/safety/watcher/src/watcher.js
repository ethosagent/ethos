// Ch.6a — Watcher.
//
// Pure dispatch over the rule list. The host (CLI / web profile / cron)
// owns the consumer side: forwards events from `AgentLoop.run()` into
// `watcher.observe(event)`, and acts on the returned decision. Decisions
// are also surfaced via the optional WatcherObservability adapter so the
// host can record them (e.g. `ethos security audit`).
import { defaultRules } from './rules';
import { makeInitialState } from './types';
export class Watcher {
  rules;
  state = makeInitialState();
  observability;
  traceId;
  constructor(opts = {}) {
    this.rules = opts.rules ?? defaultRules();
    if (opts.observability) this.observability = opts.observability;
    if (opts.traceId) this.traceId = opts.traceId;
  }
  /** Drives the rule list against a single event. Returns the first
   *  non-allow decision, or `{ action: 'allow' }` if every rule
   *  passed. Records non-allow decisions in observability. */
  observe(event) {
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
  resetTurn() {
    for (const rule of this.rules) rule.onTurnReset?.(this.state);
  }
}
