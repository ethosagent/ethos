// Ch.7.0 — Scheme allowlist (gate-zero, runs before DNS or policy work).
//
// Only `http://` and `https://` are accepted on URL-typed tool args. The rest
// — `file://`, `gopher://`, `dict://`, `ldap://`, `ftp://`, `data:`, `javascript:`,
// custom app schemes — are always rejected. URLs with embedded auth
// (`http://user:pass@host`) are also rejected because the `host` part is
// what matters and the credentials shape is suspicious.

export interface SchemeCheckResult {
  ok: boolean;
  reason?: string;
}

export function checkScheme(url: string): SchemeCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `URL_SCHEME_REJECTED: malformed URL '${url}'` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `URL_SCHEME_REJECTED: scheme '${parsed.protocol.replace(':', '')}' not allowed (only http/https)`,
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: 'URL_SCHEME_REJECTED: URLs with embedded credentials are not allowed',
    };
  }
  return { ok: true };
}
