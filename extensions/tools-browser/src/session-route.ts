// ---------------------------------------------------------------------------
// Session creation with SSRF route protection
// ---------------------------------------------------------------------------

import { lookup } from 'node:dns/promises';
import { type NetworkPolicy, validateUrl } from '@ethosagent/safety-network';
import { type BrowserSession, getOrCreateSession } from './sessions';

async function resolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

// Tracks which sessions have had their context-level route installed.
const installedRoutes = new WeakSet<BrowserSession>();

// Schemes the browser route allows through without policy validation.
// Default-deny: anything not on this list is aborted.
const BROWSER_ALLOWED_NON_HTTP_PREFIXES = ['about:'];

export async function getOrCreateSessionWithRoute(
  sessionId: string,
  policy: NetworkPolicy,
): Promise<BrowserSession> {
  const session = await getOrCreateSession(sessionId, policy);
  if (!installedRoutes.has(session)) {
    await session.context.route('**/*', async (route) => {
      const reqUrl = route.request().url();
      const isHttp = reqUrl.startsWith('http://') || reqUrl.startsWith('https://');
      if (!isHttp) {
        const allowed = BROWSER_ALLOWED_NON_HTTP_PREFIXES.some((p) => reqUrl.startsWith(p));
        if (allowed) {
          await route.continue();
          return;
        }
        await route.abort('failed');
        return;
      }
      const check = await validateUrl(reqUrl, policy, resolveHost);
      if (!check.ok) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    installedRoutes.add(session);
  }
  return session;
}
