// FW-10 — verbose levels for the chat surface.
//
// Four discrete levels modulate what `renderEvent()` emits. The audience
// boundary (Phase 30.2) is the gate at `default`: tools tag a progress event
// `audience: 'user'` to opt-in. `verbose` lifts the gate so internal
// `audience: 'internal'` events surface too. `debug` adds raw JSON.
export const VERBOSITY_LEVELS = ['quiet', 'default', 'verbose', 'debug'];
const CYCLE = ['default', 'verbose', 'debug', 'quiet'];
export function isVerbosity(v) {
    return VERBOSITY_LEVELS.includes(v);
}
/**
 * `/verbose` (no arg) cycles through `default → verbose → debug → quiet → default`.
 * Any unknown current level falls back to `default` so the cycle re-anchors.
 */
export function nextVerbosity(current) {
    const idx = CYCLE.indexOf(current);
    const next = CYCLE[(idx + 1) % CYCLE.length];
    return next ?? 'default';
}
/**
 * Pure event-to-line(s) projection. Used by tests; the live REPL renders with
 * ANSI directly but consults the same level/audience rules.
 *
 * Returns [] for events filtered out at the current level.
 */
export function projectEvent(event, verbosity) {
    if (verbosity === 'quiet') {
        // Only final assistant text surfaces.
        if (event.type === 'text_delta')
            return [{ text: event.text, kind: 'text' }];
        return [];
    }
    const out = [];
    switch (event.type) {
        case 'text_delta':
            out.push({ text: event.text, kind: 'text' });
            break;
        case 'tool_start':
            out.push({ text: `⟳ ${event.toolName}`, kind: 'tool_start' });
            break;
        case 'tool_progress': {
            // Phase 30.2 — `default` honours the audience gate; `verbose`+ lifts it.
            const isUserOptIn = event.audience === 'user';
            if (verbosity === 'default' && !isUserOptIn)
                break;
            out.push({
                text: `· ${event.toolName}: ${event.message}`,
                kind: 'tool_progress',
            });
            break;
        }
        case 'tool_end':
            out.push({
                text: `${event.ok ? '✓' : '✗'} ${event.toolName} ${event.durationMs}ms`,
                kind: 'tool_end',
            });
            break;
        case 'usage':
            out.push({
                text: `${event.inputTokens} in · ${event.outputTokens} out`,
                kind: 'usage',
            });
            break;
        case 'error':
            out.push({ text: `[${event.code}] ${event.error}`, kind: 'error' });
            break;
        case 'run_start':
            if (verbosity === 'verbose' || verbosity === 'debug') {
                out.push({
                    text: `↳ ${event.provider}/${event.model} (${event.source})`,
                    kind: 'run_start',
                });
            }
            break;
        case 'thinking_delta':
        case 'done':
        case 'context_meta':
            // Not surfaced at any verbosity in the line projection. `done` triggers
            // turn summary inline in the REPL; `context_meta` is internal.
            break;
    }
    if (verbosity === 'debug') {
        out.push({ text: `[debug] ${JSON.stringify(event)}`, kind: 'debug' });
    }
    return out;
}
