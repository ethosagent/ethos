// Ch.6a — In-process watcher.
//
// Subscribes to the AgentEvent stream (defined in @ethosagent/core) and
// evaluates policy rules. When a rule fires, the watcher emits a
// WatcherDecision; the consumer (CLI, web, gateway) is responsible for
// acting on it (rendering a chip, calling abortSignal.abort(), promoting
// the next tool to approval-required, etc.).
//
// We keep the consumer-side action OUT of this module so the watcher is
// usable from any surface — the same rules fire whether the host is the
// CLI REPL, a web SSE channel, or a cron job. Decisions also stream
// through ObservabilityWriter as `audit.watcher` events for `ethos
// security audit` to surface.

export type WatcherDecision =
  | { action: 'allow' }
  | { action: 'pause'; rule: string; reason: string }
  | { action: 'force_approval'; rule: string; reason: string }
  | { action: 'terminate'; rule: string; reason: string };

export interface WatcherEvent {
  /** Discriminator that mirrors AgentEvent type names (text_delta,
   *  tool_start, tool_end, etc.). The watcher only inspects fields it
   *  cares about, so cross-version drift in unrelated event types is
   *  safe. */
  type: string;
  toolName?: string;
  ok?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  args?: unknown;
}

export interface WatcherRule {
  /** Stable rule id used in observability events + decisions. */
  id: string;
  /** One-shot evaluation per event. Returns a non-allow decision when
   *  the rule trips; `null` means no action taken on this event. State
   *  lives in the rule's closure / the WatcherState struct. */
  evaluate(event: WatcherEvent, state: WatcherState): WatcherDecision | null;
  /** Called when a fresh user turn begins so per-turn counters reset. */
  onTurnReset?(state: WatcherState): void;
}

export interface WatcherState {
  /** Sliding window of recent tool_end timestamps (per tool name). */
  recentToolEnds: Map<string, number[]>;
  /** Per-turn output-token total. Reset each turn. */
  outputTokensThisTurn: number;
  /** Per-tool consecutive-failure count. */
  consecutiveFailures: Map<string, number>;
  /** Recent (last 4) tool calls — name + first 200 chars of args, used
   *  by the suspicious-sequence rule. */
  recentCalls: Array<{ name: string; argSnippet: string }>;
}

export function makeInitialState(): WatcherState {
  return {
    recentToolEnds: new Map(),
    outputTokensThisTurn: 0,
    consecutiveFailures: new Map(),
    recentCalls: [],
  };
}
