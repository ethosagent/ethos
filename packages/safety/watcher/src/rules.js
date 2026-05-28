// Ch.6a — Built-in watcher rules.
//
// Each rule is a closure over its config. State lives on WatcherState so
// rules don't keep their own per-instance memory (makes them safe to
// instantiate per-session and easy to test).
export function rateLimitRule(opts = {}) {
    const max = opts.max ?? 30;
    const windowMs = opts.windowMs ?? 60_000;
    return {
        id: 'rate-limit',
        evaluate(event, state) {
            if (event.type !== 'tool_end' || !event.toolName)
                return null;
            const now = Date.now();
            const all = aggregateRecent(state, now, windowMs);
            all.push(now);
            const tail = all.slice(-max - 1);
            // Track per-tool too so we can name the offender for telemetry, but
            // the cap is a global call rate.
            const list = state.recentToolEnds.get(event.toolName) ?? [];
            list.push(now);
            state.recentToolEnds.set(event.toolName, list);
            pruneAll(state, now, windowMs);
            if (tail.length > max) {
                return {
                    action: 'pause',
                    rule: 'rate-limit',
                    reason: `Tool-call rate exceeded: > ${max} calls in ${Math.round(windowMs / 1000)}s`,
                };
            }
            return null;
        },
        onTurnReset() {
            // Rate limit is intentionally cross-turn — a runaway loop spread across
            // many short turns is exactly the shape we want to catch.
        },
    };
}
function aggregateRecent(state, now, windowMs) {
    const all = [];
    for (const list of state.recentToolEnds.values()) {
        for (const t of list)
            if (t > now - windowMs)
                all.push(t);
    }
    return all;
}
function pruneAll(state, now, windowMs) {
    for (const [name, list] of state.recentToolEnds.entries()) {
        const fresh = list.filter((t) => t > now - windowMs);
        if (fresh.length === 0)
            state.recentToolEnds.delete(name);
        else
            state.recentToolEnds.set(name, fresh);
    }
}
export function tokenBudgetRule(opts = {}) {
    const max = opts.max ?? 50_000;
    return {
        id: 'token-budget',
        evaluate(event, state) {
            if (event.type !== 'usage' || event.outputTokens === undefined)
                return null;
            state.outputTokensThisTurn += event.outputTokens;
            if (state.outputTokensThisTurn > max) {
                return {
                    action: 'pause',
                    rule: 'token-budget',
                    reason: `Output token budget exceeded: ${state.outputTokensThisTurn} > ${max} this turn`,
                };
            }
            return null;
        },
        onTurnReset(state) {
            state.outputTokensThisTurn = 0;
        },
    };
}
export function compoundingErrorRule(opts = {}) {
    const threshold = opts.threshold ?? 3;
    return {
        id: 'compounding-error',
        evaluate(event, state) {
            if (event.type !== 'tool_end' || !event.toolName)
                return null;
            const tool = event.toolName;
            if (event.ok === false) {
                const count = (state.consecutiveFailures.get(tool) ?? 0) + 1;
                state.consecutiveFailures.set(tool, count);
                if (count >= threshold) {
                    return {
                        action: 'pause',
                        rule: 'compounding-error',
                        reason: `${tool} failed ${count} times in a row`,
                    };
                }
            }
            else {
                state.consecutiveFailures.delete(tool);
            }
            return null;
        },
    };
}
// ---------------------------------------------------------------------------
// Suspicious tool sequence — read of credential-shaped path → web_post
// ---------------------------------------------------------------------------
const CREDENTIAL_PATH_PATTERNS = [
    /\.ssh\b/,
    /\.aws\/credentials\b/,
    /\.gnupg\b/,
    /\.netrc\b/,
    /\/etc\/(?:passwd|shadow|sudoers)\b/,
    /authorized_keys\b/,
];
const EXFIL_TOOL_NAMES = new Set([
    'web_post',
    'web_put',
    'web_delete',
    'email_send',
    'browser_type', // typing into a form is exfil-shaped
]);
export function suspiciousSequenceRule(opts = {}) {
    const window = opts.window ?? 4;
    return {
        id: 'suspicious-sequence',
        evaluate(event, state) {
            if (event.type === 'tool_start' && event.toolName) {
                const arg = describeArgs(event.args);
                state.recentCalls.push({ name: event.toolName, argSnippet: arg });
                if (state.recentCalls.length > window)
                    state.recentCalls.shift();
                if (EXFIL_TOOL_NAMES.has(event.toolName)) {
                    // Look for a credential-shaped read in the recent window.
                    const credRead = state.recentCalls.find((c) => (c.name === 'read_file' || c.name === 'search_files' || c.name === 'terminal') &&
                        CREDENTIAL_PATH_PATTERNS.some((re) => re.test(c.argSnippet)));
                    if (credRead) {
                        return {
                            action: 'terminate',
                            rule: 'suspicious-sequence',
                            reason: `Credential-shaped read by ${credRead.name} → exfil-shaped ${event.toolName}`,
                        };
                    }
                }
            }
            return null;
        },
    };
}
function describeArgs(args) {
    if (!args || typeof args !== 'object')
        return '';
    const a = args;
    if (typeof a.path === 'string')
        return a.path.slice(0, 200);
    if (typeof a.url === 'string')
        return a.url.slice(0, 200);
    if (typeof a.command === 'string')
        return a.command.slice(0, 200);
    return JSON.stringify(a).slice(0, 200);
}
// ---------------------------------------------------------------------------
// Default rule set
// ---------------------------------------------------------------------------
export function defaultRules() {
    return [rateLimitRule(), tokenBudgetRule(), compoundingErrorRule(), suspiciousSequenceRule()];
}
