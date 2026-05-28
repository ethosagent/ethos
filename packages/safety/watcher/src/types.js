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
export function makeInitialState() {
    return {
        recentToolEnds: new Map(),
        outputTokensThisTurn: 0,
        consecutiveFailures: new Map(),
        recentCalls: [],
    };
}
