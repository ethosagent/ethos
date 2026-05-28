import { validateUrl as validateSsrfUrl } from '@ethosagent/core';
import { safeFetch } from '@ethosagent/safety-network';
export async function probeTokenScopes(
  server,
  introspectionEndpoint,
  declaredScopes,
  bearerToken,
  logger,
) {
  const base = {
    server,
    declaredScopes,
  };
  try {
    // SSRF gate: validate introspection endpoint before sending bearer token
    validateSsrfUrl(introspectionEndpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let resp;
    try {
      const result = await safeFetch(introspectionEndpoint, {
        policy: {},
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: bearerToken }),
          signal: controller.signal,
        },
      });
      clearTimeout(timer);
      if (!result.ok) {
        logger.warn(`[ethos] Scope probe blocked for '${server}': ${result.reason}`, {
          component: 'tools-mcp',
          server,
        });
        return { ...base, outcome: 'error', actualScopes: [], error: result.reason };
      }
      resp = result.response;
    } catch (err) {
      clearTimeout(timer);
      return { ...base, outcome: 'error', actualScopes: [], error: String(err) };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      logger.warn(`[ethos] Scope probe failed for '${server}': HTTP ${resp.status}`, {
        component: 'tools-mcp',
        server,
        status: resp.status,
      });
      return { ...base, outcome: 'error', actualScopes: [], error: `HTTP ${resp.status}: ${text}` };
    }
    const body = await resp.json();
    if (body.active === false) {
      logger.warn(`[ethos] Scope probe: token inactive for '${server}'`, {
        component: 'tools-mcp',
        server,
      });
      return { ...base, outcome: 'inactive', actualScopes: [] };
    }
    const actualScopes = body.scope ? body.scope.split(' ').filter(Boolean) : [];
    const declaredSet = new Set(declaredScopes);
    const actualSet = new Set(actualScopes);
    const missing = declaredScopes.filter((s) => !actualSet.has(s));
    const extra = actualScopes.filter((s) => !declaredSet.has(s));
    if (missing.length === 0 && extra.length === 0) {
      return { ...base, outcome: 'match', actualScopes };
    }
    logger.warn(
      `[ethos] Scope probe: mismatch for '${server}' — missing: [${missing.join(', ')}], extra: [${extra.join(', ')}]`,
      { component: 'tools-mcp', server, missing, extra },
    );
    return { ...base, outcome: 'mismatch', actualScopes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[ethos] Scope probe error for '${server}': ${msg}`, {
      component: 'tools-mcp',
      server,
      error: msg,
    });
    return { ...base, outcome: 'error', actualScopes: [], error: msg };
  }
}
