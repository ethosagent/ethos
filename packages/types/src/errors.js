// Phase 30.9 — Error envelope discipline.
//
// Every user-facing error has a code, a one-line cause, and a suggested action.
// `EthosError` extends `Error` so it throws and catches like any other error,
// but carries the structured payload that surfaces (CLI, gateway, web API)
// render with `formatError`.
//
// Library code (packages/core, extensions/*) may still `throw new Error(...)`.
// Surface code (apps/ethos/src/commands/*, gateway adapters, web routes) must
// throw `EthosError` — enforced by the lint test in tests/lint/.
//
// Keep this file zero-dep and side-effect-free; @ethosagent/types is imported
// by every package and must stay safe to load anywhere.
/**
 * Surface-layer error. Throw from CLI commands, gateway adapters, and the web
 * API. Catch-all rendering in the surface picks up `code/cause/action`.
 */
export class EthosError extends Error {
    code;
    cause;
    action;
    details;
    constructor(init) {
        // Use `cause` as the Error message so existing `err.message` consumers keep
        // working. The structured fields live alongside.
        super(init.cause);
        this.name = 'EthosError';
        this.code = init.code;
        this.cause = init.cause;
        this.action = init.action;
        if (init.details !== undefined)
            this.details = init.details;
    }
}
export function isEthosError(err) {
    return err instanceof EthosError;
}
/**
 * Wrap an unknown error so callers can render it through the same path. Used
 * by the top-level handler in `apps/ethos/src/index.ts` to coerce stray
 * exceptions from library code into the envelope shape.
 */
export function toEthosError(err, fallbackCode = 'INTERNAL') {
    if (isEthosError(err))
        return err;
    const cause = err instanceof Error ? err.message : String(err);
    return new EthosError({
        code: fallbackCode,
        cause: cause || 'Unknown error',
        action: 'Re-run with the same inputs. If the error repeats, file an issue with the message.',
        details: err instanceof Error ? { name: err.name, stack: err.stack } : { value: err },
    });
}
const ANSI = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
};
/**
 * Render an `EthosError` into the standard 3-line block:
 *
 *     ✗ <CODE>: <cause>
 *       → <action>
 *
 * Surfaces (CLI, gateway adapters) call this and pipe the result to stderr or
 * the user channel.
 */
export function formatError(err, opts = {}) {
    const color = opts.color === true;
    const c = color ? ANSI : { reset: '', red: '', yellow: '', dim: '', bold: '' };
    return [
        `${c.red}✗ ${c.bold}${err.code}${c.reset}${c.red}:${c.reset} ${err.cause}`,
        `  ${c.dim}→${c.reset} ${err.action}`,
    ].join('\n');
}
// ---------------------------------------------------------------------------
// MemoryConflictError
// ---------------------------------------------------------------------------
/**
 * Thrown by LastWriteWinsPolicy when a concurrent write is detected: the
 * entry's mtime at the time of sync() is newer than the mtime recorded when
 * the caller last read it.
 *
 * Callers may catch `MemoryConflictError` and retry after re-reading the
 * current entry.
 */
export class MemoryConflictError extends EthosError {
    key;
    scopeId;
    /** mtime recorded when the caller last read the entry (ms). */
    recordedAt;
    /** current mtime of the entry at sync() time (ms). */
    currentAt;
    constructor(opts) {
        const cause = `Conflict on "${opts.key}" in scope "${opts.scopeId}": ` +
            `entry modified at ${opts.currentAt} but caller last read at ${opts.recordedAt}`;
        super({
            code: 'MEMORY_CONFLICT',
            cause,
            action: 'Re-read the entry and retry the sync.',
        });
        this.name = 'MemoryConflictError';
        this.key = opts.key;
        this.scopeId = opts.scopeId;
        this.recordedAt = opts.recordedAt;
        this.currentAt = opts.currentAt;
    }
}
