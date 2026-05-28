// ---------------------------------------------------------------------------
// Shared browser session state
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
const MAX_CONSOLE_LOGS = 200;
const sessions = new Map();
/**
 * @internal
 *
 * Stable, order-independent hash of the policy alone. Used both as part
 * of the session map key (combined with sessionId) AND stored on the
 * BrowserSession as `policyFingerprint`. Two separate identifiers — see
 * `makeMapKey` below — so the security invariant check in
 * findActiveSession compares policy-to-policy, not key-to-key.
 *
 * Exported ONLY so tests can construct adversarial scenarios (right
 * map key + wrong fingerprint, etc.) without re-implementing the hash.
 * Not stable API — production callers must not depend on the format.
 */
export function policyFingerprint(policy) {
    const sorted = {
        allow: [...(policy.allow ?? [])].sort(),
        deny: [...(policy.deny ?? [])].sort(),
        allow_private_urls: !!policy.allow_private_urls,
    };
    return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}
/**
 * @internal
 *
 * Map key for the sessions Map. Exported for the same reason as
 * `policyFingerprint` — tests need it to construct adversarial
 * fixtures. Not stable API.
 */
export function makeMapKey(sessionId, policy) {
    return `${sessionId}::${policyFingerprint(policy)}`;
}
// Back-compat surface — older callers (browser_click etc.) only know the
// sessionId, so the key-by-policy machinery hides behind getOrCreateSession.
export { sessions };
/**
 * Strict session lookup keyed by (sessionId, current policy fingerprint).
 *
 * Used by every browser tool that can cause network traffic (click, type,
 * screenshot, vision-*). Returns the session ONLY when its
 * policyFingerprint matches the current policy. A mismatch returns
 * undefined so the caller can refuse with a "no session under current
 * policy" error rather than navigating under stale rules.
 *
 * The map-key match is the fast path; the security invariant is the
 * explicit `session.policyFingerprint === fingerprint` check below. We
 * do NOT trust that whoever wrote the map-key used `makeKey` correctly
 * — a stray writer (test, future plugin) could otherwise insert a
 * BrowserSession under the expected key with a stale fingerprint.
 *
 * Tools must NOT use a sessionId-only lookup — that path is the
 * stale-policy hole Codex called out.
 */
export function findActiveSession(sessionId, policy) {
    const fp = policyFingerprint(policy);
    const session = sessions.get(makeMapKey(sessionId, policy));
    if (!session)
        return undefined;
    // Explicit invariant — the map key is the fast path; the recorded
    // session.policyFingerprint is what actually gates the lookup.
    if (session.policyFingerprint !== fp)
        return undefined;
    return session;
}
export async function getChromium() {
    const { chromium } = await import('playwright');
    return chromium;
}
export async function getOrCreateSession(sessionId, policy = {}) {
    const fp = policyFingerprint(policy);
    const key = makeMapKey(sessionId, policy);
    const exact = sessions.get(key);
    // The map-key match is the fast path; the security invariant is the
    // explicit fingerprint comparison. A session inserted under the right
    // key with a stale `policyFingerprint` (test, plugin, future bug) gets
    // torn down rather than reused.
    if (exact && exact.policyFingerprint === fp)
        return exact;
    if (exact) {
        sessions.delete(key);
        await exact.context.close().catch(() => { });
        await exact.browser.close().catch(() => { });
    }
    // Tear down any prior session for the same sessionId under a
    // different policy fingerprint — that's the protection against
    // browser_click / browser_type running under a stale policy.
    for (const [k, s] of sessions.entries()) {
        if (k.startsWith(`${sessionId}::`) && s.policyFingerprint !== fp) {
            sessions.delete(k);
            await s.context.close().catch(() => { });
            await s.browser.close().catch(() => { });
        }
    }
    const chromium = await getChromium();
    const noSandbox = process.env.ETHOS_BROWSER_NO_SANDBOX === '1';
    if (noSandbox) {
        process.stderr.write('[ethos] WARNING: browser sandbox disabled via ETHOS_BROWSER_NO_SANDBOX=1 — only use in trusted environments without userns support\n');
    }
    const browser = await chromium.launch({
        args: [...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []), '--disable-gpu'],
    });
    // serviceWorkers: 'block' — a registered service worker can intercept
    // fetches before page.route() sees them (Playwright documents this
    // behavior). Blocking SW registration at the context level closes
    // the bypass.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const session = {
        browser,
        context,
        page,
        refs: new Map(),
        lastUrl: '',
        policyFingerprint: fp,
        consoleLogs: [],
    };
    // Capture console messages for browser_console tool
    page.on('console', (msg) => {
        const type = msg.type();
        const text = msg.text();
        if (session.consoleLogs.length >= MAX_CONSOLE_LOGS) {
            session.consoleLogs.shift();
        }
        session.consoleLogs.push(`[${type}] ${text}`);
    });
    // Capture dialogs (alert/confirm/prompt) for browser_dialog tool.
    // Playwright dialogs block the triggering page action until handled.
    // Auto-dismiss immediately to prevent deadlock, but record the event
    // so the agent can inspect what happened via browser_console / browser_dialog.
    page.on('dialog', async (dialog) => {
        const entry = `[dialog:${dialog.type()}] ${dialog.message()}`;
        if (session.consoleLogs.length >= MAX_CONSOLE_LOGS) {
            session.consoleLogs.shift();
        }
        session.consoleLogs.push(entry);
        // Auto-dismiss to unblock the page. Alerts are accepted (they only have OK).
        // Confirms/prompts are dismissed (safest default).
        if (dialog.type() === 'alert') {
            await dialog.accept();
        }
        else {
            await dialog.dismiss();
        }
    });
    sessions.set(key, session);
    return session;
}
export async function closeSession(sessionId) {
    for (const [k, s] of sessions.entries()) {
        if (k.startsWith(`${sessionId}::`) || k === sessionId) {
            sessions.delete(k);
            await s.context.close().catch(() => { });
            await s.browser.close().catch(() => { });
        }
    }
}
/**
 * Close ALL browser sessions. Use when the agent loop aborts or the process
 * is shutting down — prevents headless Chromium instances from leaking.
 */
export async function closeAllSessions() {
    const entries = [...sessions.entries()];
    sessions.clear();
    await Promise.allSettled(entries.map(async ([, s]) => {
        await s.context.close().catch(() => { });
        await s.browser.close().catch(() => { });
    }));
}
export function isPlaywrightInstalled() {
    try {
        import.meta.resolve('playwright');
        return true;
    }
    catch {
        return false;
    }
}
// Cleanup all sessions on process exit
function cleanupOnExit() {
    for (const s of sessions.values()) {
        s.browser.close().catch(() => { });
    }
    sessions.clear();
}
process.on('SIGTERM', cleanupOnExit);
process.on('SIGINT', cleanupOnExit);
