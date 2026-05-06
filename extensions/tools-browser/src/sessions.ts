// ---------------------------------------------------------------------------
// Shared browser session state
// ---------------------------------------------------------------------------

import type { Browser, Page } from 'playwright';
import type { A11yRef } from './a11y';

export interface BrowserSession {
  browser: Browser;
  page: Page;
  refs: Map<string, A11yRef>;
  lastUrl: string;
  /**
   * Ch.7 — mutable network policy ref read by the page-route interceptor.
   * `browse_url` writes the active personality's policy here on every call;
   * the route handler installed once per session reads it. Keeping the
   * handler stable (set-once) avoids the Playwright route-stacking
   * footgun where calling `page.route` repeatedly accumulates handlers.
   */
  networkPolicyRef: {
    current: { allow?: string[]; deny?: string[]; allow_private_urls?: boolean };
  };
  /** True once the route interceptor is installed. */
  routeInstalled?: boolean;
}

export const sessions = new Map<string, BrowserSession>();

export async function getChromium() {
  const { chromium } = await import('playwright');
  return chromium;
}

export async function getOrCreateSession(sessionId: string): Promise<BrowserSession> {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const chromium = await getChromium();
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();

  const session: BrowserSession = {
    browser,
    page,
    refs: new Map(),
    lastUrl: '',
    networkPolicyRef: { current: {} },
  };
  sessions.set(sessionId, session);
  return session;
}

export async function closeSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  await s.browser.close().catch(() => {});
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
