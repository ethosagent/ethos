import { hashApiKey } from '@ethosagent/session-sqlite';
/** Express the OpenAI error shape over Hono so callers don't repeat the wire format. */
export function openAiErrorBody(input) {
    const body = {
        error: {
            message: input.message,
            type: input.type,
            code: input.code,
            param: input.param ?? null,
        },
    };
    if (input.request_id)
        body.error.request_id = input.request_id;
    return body;
}
const BEARER_PREFIX = 'Bearer ';
const SECRET_PREFIX = 'sk-ethos-';
/**
 * Coalesce `last_used` writes so a streaming Cursor / Aider client doesn't
 * turn every authenticated hit into a SQLite write contention point. The
 * `last_used` UX granularity is "minute or so", well within this window.
 */
const TOUCH_THROTTLE_MS = 60_000;
export function bearerAuth(opts) {
    const lastTouchAt = new Map();
    return async (c, next) => {
        const header = c.req.header('authorization') ?? c.req.header('Authorization');
        if (!header)
            return invalidAuth(c, 'Missing Authorization header.');
        if (!header.startsWith(BEARER_PREFIX)) {
            return invalidAuth(c, 'Authorization header must use the Bearer scheme.');
        }
        const secret = header.slice(BEARER_PREFIX.length).trim();
        if (!secret.startsWith(SECRET_PREFIX)) {
            return invalidAuth(c, 'API key must start with `sk-ethos-`.');
        }
        const record = await opts.store.findByHash(hashApiKey(secret));
        if (!record)
            return invalidAuth(c, 'API key is invalid or has been revoked.');
        if (!record.scopes.includes(opts.scope)) {
            return forbidden(c, `API key is missing required scope "${opts.scope}".`);
        }
        // Best-effort observability — throttled so we don't take the SQLite write
        // lock on every authenticated request (streaming Cursor traffic would
        // otherwise serialise behind the auth middleware).
        const now = Date.now();
        const previous = lastTouchAt.get(record.id) ?? 0;
        if (now - previous >= TOUCH_THROTTLE_MS) {
            lastTouchAt.set(record.id, now);
            try {
                await opts.store.touchLastUsed(record.id);
            }
            catch {
                // intentionally ignored — never fail a request for a metadata write
            }
        }
        c.set('apiKey', record);
        await next();
    };
}
function invalidAuth(c, message) {
    return c.json(openAiErrorBody({ message, type: 'authentication_error', code: 'invalid_api_key' }), 401);
}
function forbidden(c, message) {
    return c.json(openAiErrorBody({ message, type: 'permission_error', code: 'insufficient_scope' }), 403);
}
