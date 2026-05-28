import { redactString } from '@ethosagent/safety-redact';
const MAX_STRING_LENGTH = 500;
export function redactArgs(args) {
    if (typeof args === 'string') {
        const redacted = redactString(args);
        if (redacted.length > MAX_STRING_LENGTH) {
            return `${redacted.slice(0, MAX_STRING_LENGTH)}...[truncated, ${redacted.length} chars]`;
        }
        return redacted;
    }
    if (Array.isArray(args)) {
        return args.map(redactArgs);
    }
    if (args !== null && typeof args === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(args)) {
            out[k] = redactArgs(v);
        }
        return out;
    }
    return args;
}
export function synthesizeDryRunResult(toolName, args) {
    const redacted = redactArgs(args);
    return {
        ok: true,
        value: `[dry-run] ${toolName} would be called with: ${JSON.stringify(redacted)}`,
    };
}
export function synthesizeDryRunCapResult(_toolName, cap) {
    return {
        ok: false,
        error: `[dry-run] tool call cap (${cap}) reached — stopping tool execution for this turn`,
        code: 'not_available',
    };
}
