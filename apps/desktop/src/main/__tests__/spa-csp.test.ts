import { describe, expect, it } from 'vitest';
import { applySpaCsp } from '../spa-csp';

// The desktop window loads the SPA over HTTP from the web-api (the embedded
// local one, or a remote one) — `loadSpaUrl`/`loadRemoteUrl` in ../index.ts,
// never file:// — and that server already sets a Content-Security-Policy on
// every response (`cspMiddleware`, apps/web-api/src/middleware/csp.ts): a
// framing-only one on the SPA shell, a strict nonce'd one on everything else,
// including the `/oauth/callback` page's inline script. `setupSpaCsp` layers the
// desktop's own policy on top of whatever arrived.

const CONNECT = "'self' http://127.0.0.1:* ws://127.0.0.1:*";

function cspValues(headers: Record<string, string[]>): string[] {
  return Object.entries(headers)
    .filter(([k]) => k.toLowerCase() === 'content-security-policy')
    .flatMap(([, v]) => v);
}

function cspKeys(headers: Record<string, string[]>): string[] {
  return Object.keys(headers).filter((k) => k.toLowerCase() === 'content-security-policy');
}

function directive(policy: string, name: string): string | undefined {
  return policy
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));
}

/** Whether every policy in the list lets an inline <script> without a nonce run. */
function allowsPlainInlineScript(policies: string[]): boolean {
  return policies.every((p) => {
    const src = directive(p, 'script-src') ?? directive(p, 'default-src');
    return src === undefined || (src.includes("'unsafe-inline'") && !src.includes("'nonce-"));
  });
}

/** Whether every policy lets an inline <script nonce=n> run. */
function allowsNoncedScript(policies: string[], nonce: string): boolean {
  return policies.every((p) => {
    const src = directive(p, 'script-src') ?? directive(p, 'default-src');
    return src === undefined || src.includes(`'nonce-${nonce}'`) || src.includes("'unsafe-inline'");
  });
}

describe('applySpaCsp', () => {
  it('keeps the SPA shell policy the web-api sent, under ONE header name, and lets its inline bootstrap run', () => {
    const out = applySpaCsp(
      { 'content-security-policy': ["frame-ancestors 'none'"], 'content-type': ['text/html'] },
      CONNECT,
    );
    expect(cspKeys(out)).toHaveLength(1);
    const policies = cspValues(out);
    expect(policies).toContain("frame-ancestors 'none'");
    // apps/web/index.html carries an inline bootstrap <script>, and chat
    // previews are srcdoc iframes that inherit the page's policy.
    expect(allowsPlainInlineScript(policies)).toBe(true);
    // The desktop's own restriction still applies on top.
    expect(policies.some((p) => directive(p, 'connect-src') === `connect-src ${CONNECT}`)).toBe(
      true,
    );
    expect(out['content-type']).toEqual(['text/html']);
  });

  it("does not block the /oauth/callback page's nonce'd inline script", () => {
    const strict =
      "default-src 'self'; script-src 'self' 'nonce-abc123'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";
    const out = applySpaCsp({ 'Content-Security-Policy': [strict] }, CONNECT);
    expect(cspKeys(out)).toHaveLength(1);
    const policies = cspValues(out);
    expect(policies).toContain(strict);
    expect(allowsNoncedScript(policies, 'abc123')).toBe(true);
  });

  it('applies the desktop policy alone when the response carries none', () => {
    const out = applySpaCsp({ 'content-type': ['application/json'] }, CONNECT);
    const policies = cspValues(out);
    expect(policies).toHaveLength(1);
    expect(directive(policies[0] ?? '', 'connect-src')).toBe(`connect-src ${CONNECT}`);
    expect(directive(policies[0] ?? '', 'default-src')).toBe("default-src 'self'");
  });
});
