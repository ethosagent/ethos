// FW-9 — Steer sink interface.
//
// Surfaces (CLI REPL, gateway slash dispatchers) push user-typed text while
// the agent is mid-turn. AgentLoop drains the sink at the iteration seam
// (between tool_results landing and the next LLM call) and folds each entry
// in as a `[USER STEER]: <text>` text block on the user message that carries
// the tool_results.

export interface SteerSink {
  /** Append a steer entry. Returns false if the sink is closed/full. */
  push(text: string): boolean;
  /** Atomically remove and return everything currently queued. */
  drain(): string[];
  /** Number of entries currently queued. */
  depth(): number;
}
