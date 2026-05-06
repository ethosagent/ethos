// ---------------------------------------------------------------------------
// Shared browser session state
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { A11yRef } from './a11y';

export interface NetworkPolicyShape {
  allow?: string[];
  deny?: string[];
  allow_private_urls?: boolean;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  refs: Map<string, A11yRef>;
  lastUrl: string;
  /**
   * Ch.7 — fingerprint of the network policy this session was created
   * under. The session is keyed by (sessionId, policyFingerprint), so
   * a personality / policy switch lookups-misses and forces a fresh
   * session with a fresh route handler + serviceWorkers='block' on
   * its own BrowserContext. Eliminates the race where browser_click
   * triggers a navigation gated by a stale policy ref.
   */
  policyFingerprint: string;
}

const sessions = new Map<string, BrowserSession>();

/**
 * Stable, order-independent hash of the policy alone. Used both as part
 * of the session map key (combined with sessionId) AND stored on the
 * BrowserSession as `policyFingerprint`. Two separate identifiers — see
 * `makeMapKey` below — so the security invariant check in
 * findActiveSession compares policy-to-policy, not key-to-key.
 *
 * Exported so tests can construct adversarial scenarios (right map
 * key + wrong fingerprint, etc.) without re-implementing the hash.
 */
export function policyFingerprint(policy: NetworkPolicyShape): string {
  const sorted = {
    allow: [...(policy.allow ?? [])].sort(),
    deny: [...(policy.deny ?? [])].sort(),
    allow_private_urls: !!policy.allow_private_urls,
  };
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

/** Map key for the sessions Map. Exported for the same reason as
 *  policyFingerprint — tests need it to construct adversarial fixtures. */
export function makeMapKey(sessionId: string, policy: NetworkPolicyShape): string {
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
export function findActiveSession(
  sessionId: string,
  policy: NetworkPolicyShape,
): BrowserSession | undefined {
  const fp = policyFingerprint(policy);
  const session = sessions.get(makeMapKey(sessionId, policy));
  if (!session) return undefined;
  // Explicit invariant — the map key is the fast path; the recorded
  // session.policyFingerprint is what actually gates the lookup.
  if (session.policyFingerprint !== fp) return undefined;
  return session;
}

export async function getChromium() {
  const { chromium } = await import('playwright');
  return chromium;
}

export async function getOrCreateSession(
  sessionId: string,
  policy: NetworkPolicyShape = {},
): Promise<BrowserSession> {
  const fp = policyFingerprint(policy);
  const key = makeMapKey(sessionId, policy);

  const exact = sessions.get(key);
  // The map-key match is the fast path; the security invariant is the
  // explicit fingerprint comparison. A session inserted under the right
  // key with a stale `policyFingerprint` (test, plugin, future bug) gets
  // torn down rather than reused.
  if (exact && exact.policyFingerprint === fp) return exact;
  if (exact) {
    sessions.delete(key);
    await exact.context.close().catch(() => {});
    await exact.browser.close().catch(() => {});
  }

  // Tear down any prior session for the same sessionId under a
  // different policy fingerprint — that's the protection against
  // browser_click / browser_type running under a stale policy.
  for (const [k, s] of sessions.entries()) {
    if (k.startsWith(`${sessionId}::`) && s.policyFingerprint !== fp) {
      sessions.delete(k);
      await s.context.close().catch(() => {});
      await s.browser.close().catch(() => {});
    }
  }

  const chromium = await getChromium();
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  // serviceWorkers: 'block' — a registered service worker can intercept
  // fetches before page.route() sees them (Playwright documents this
  // behavior). Blocking SW registration at the context level closes
  // the bypass.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();

  const session: BrowserSession = {
    browser,
    context,
    page,
    refs: new Map(),
    lastUrl: '',
    policyFingerprint: fp,
  };
  sessions.set(key, session);
  return session;
}

export async function closeSession(sessionId: string): Promise<void> {
  for (const [k, s] of sessions.entries()) {
    if (k.startsWith(`${sessionId}::`) || k === sessionId) {
      sessions.delete(k);
      await s.context.close().catch(() => {});
      await s.browser.close().catch(() => {});
    }
  }
}

export function isPlaywrightInstalled(): boolean {
  try {
    import.meta.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

// Cleanup all sessions on process exit
process.on('SIGTERM', () => {
  for (const s of sessions.values()) {
    s.browser.close().catch(() => {});
  }
  sessions.clear();
});
