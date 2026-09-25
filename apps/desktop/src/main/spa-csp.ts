/**
 * The desktop shell's Content-Security-Policy, layered over every response the
 * window receives (`setupSpaCsp` in ./index.ts).
 *
 * The window loads the SPA over HTTP from a web-api (`loadSpaUrl` /
 * `loadRemoteUrl`), and that server already sets its own policy on every
 * response (`cspMiddleware`, apps/web-api/src/middleware/csp.ts): framing-only
 * on the SPA shell, strict and nonce'd on everything else, `/oauth/callback`'s
 * inline script included. So the desktop policy is ADDED as a second policy,
 * never substituted: a browser enforces every policy it receives, so the
 * server's stays in force and the desktop's narrows connections, images and
 * fonts on top. Both go out under the ONE header name the server used — two
 * names differing only in case would be two headers anyway, and replacing the
 * server's name dropped its policy outright.
 *
 * `script-src` allows inline scripts because the SPA needs them — the
 * bootstrap `<script>` in apps/web/index.html, and the `srcdoc` preview
 * iframes whose inline scripts inherit the page's policy — and a nonce'd
 * server policy (a policy with a nonce ignores `'unsafe-inline'`) still gates
 * `/oauth/callback` by itself. Script ORIGINS stay `'self'`. Pinned by
 * ./__tests__/spa-csp.test.ts.
 */
export function applySpaCsp(
  responseHeaders: Record<string, string[]> | undefined,
  connectSrc: string,
): Record<string, string[]> {
  const desktop = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSrc}`,
    "img-src 'self' data: https:",
    "font-src 'self'",
  ].join('; ');

  const out: Record<string, string[]> = {};
  let cspKey = 'Content-Security-Policy';
  const server: string[] = [];
  for (const [key, values] of Object.entries(responseHeaders ?? {})) {
    if (key.toLowerCase() === 'content-security-policy') {
      cspKey = key;
      server.push(...values);
    } else {
      out[key] = values;
    }
  }
  out[cspKey] = [...server, desktop];
  return out;
}
