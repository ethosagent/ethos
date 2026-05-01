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

  const session: BrowserSession = { browser, page, refs: new Map(), lastUrl: '' };
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
