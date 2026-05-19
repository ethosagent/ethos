// Ch.7 entrypoint — composes scheme + cloud-metadata + private-network +
// per-personality allow/deny + manual redirect revalidation.
//
// The per-redirect-hop revalidation is the part most implementations miss:
// without it, an attacker hosts `https://safe.example.com/r` that returns a
// `302 Location: http://169.254.169.254/...` and exfiltrates IAM credentials
// in one fetch call. Closed by disabling auto-redirect (`redirect: 'manual'`)
// and routing every Location target back through the full pipeline before
// issuing the next request. Cap at 5 hops total.
//
// **v1 honesty about DNS rebinding.** This module resolves the hostname,
// validates every returned address, then calls `fetch(url)` and lets the
// runtime DNS-resolve a second time at connect. That closes the *naive*
// "host A resolves to a public IP, host B resolves to a private IP"
// shape — both lookups go through `node:dns`, share the OS resolver
// cache, and a TTL-based attacker still flips the answer between our
// check and the connect. Closing the racy window requires connection-
// time enforcement via an undici Agent with a custom `lookup` (or a
// per-request `lookup` on `http.request`) that returns ONLY the address
// we already authorized. That work is plan-tracked for v2 alongside
// the third-party HTTP client survey. Until then, treat DNS rebinding
// as PARTIALLY mitigated: the always-deny floor on cloud-metadata IPs
// catches the highest-value target literally, but a sufficiently-fast
// rebind can still reach an arbitrary private IP between the two
// lookups.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isCloudMetadataHost } from './cloud-metadata';
import { checkAllowDeny, type NetworkPolicy } from './policy';
import { checkScheme } from './scheme';

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true });
  return records.map((r) => r.address);
}

export interface SafeFetchOptions {
  policy: NetworkPolicy;
  /** Underlying fetch implementation; injected for testability. */
  fetchImpl?: typeof fetch;
  /** Async DNS lookup. **Defaults to node:dns/promises#lookup** so callers
   *  do NOT have to remember to plumb a resolver to get the private-network
   *  / DNS-rebinding-time-of-check protection. Injected only for tests
   *  that need deterministic addresses. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Caller-passed RequestInit. `redirect` is forced to `'manual'` and
   *  cannot be overridden — the security guarantee depends on it. */
  init?: Omit<RequestInit, 'redirect'>;
  /** Max redirect hops including the original request. Default 5. */
  maxRedirects?: number;
}

export interface SafeFetchError {
  ok: false;
  reason: string;
  hop: number;
  url: string;
}

export type SafeFetchResult =
  | { ok: true; response: Response; finalUrl: string; hops: number }
  | SafeFetchError;

const DEFAULT_MAX_REDIRECTS = 5;

export async function safeFetch(
  initialUrl: string,
  opts: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolver = opts.resolveHost ?? defaultResolveHost;
  const maxHops = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const originalOrigin = new URL(initialUrl).origin;
  let url = initialUrl;
  let init = opts.init;
  for (let hop = 0; hop < maxHops; hop++) {
    const policyCheck = await validateUrl(url, opts.policy, resolver);
    if (!policyCheck.ok) {
      return { ok: false, reason: policyCheck.reason ?? 'blocked', hop, url };
    }

    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'manual' });
    } catch (err) {
      return {
        ok: false,
        reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        hop,
        url,
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return { ok: true, response, finalUrl: url, hops: hop };
      }
      const nextUrl = new URL(location, url).toString();
      // Strip auth headers on cross-origin redirects to prevent credential leakage
      if (new URL(nextUrl).origin !== originalOrigin && init?.headers) {
        init = { ...init, headers: stripAuthHeaders(init.headers) };
      }
      url = nextUrl;
      continue;
    }

    return { ok: true, response, finalUrl: url, hops: hop };
  }

  return {
    ok: false,
    reason: `exceeded ${maxHops} redirect hops; possible loop`,
    hop: maxHops,
    url,
  };
}

interface ValidateResult {
  ok: boolean;
  reason?: string;
}

/**
 * Run the full Chapter 7 pipeline on a single URL: scheme → cloud-metadata
 * (always) → DNS resolution → private-network (unless opted in) →
 * per-personality allow/deny.
 *
 * Exported separately so a `before_tool_call` hook can validate the
 * initial URL without paying the redirect-loop overhead. `resolveHost`
 * defaults to node:dns#lookup so callers cannot accidentally weaken the
 * check by forgetting to inject a resolver.
 */
export async function validateUrl(
  url: string,
  policy: NetworkPolicy,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolveHost,
): Promise<ValidateResult> {
  const scheme = checkScheme(url);
  if (!scheme.ok) return { ok: false, reason: scheme.reason };

  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (isCloudMetadataHost(hostname)) {
    return { ok: false, reason: `cloud-metadata host '${hostname}' is always denied` };
  }

  const allowDeny = checkAllowDeny(hostname, policy);
  if (!allowDeny.allowed) return { ok: false, reason: allowDeny.reason };

  if (!policy.allow_private_urls) {
    const privateCheck = await checkPrivate(hostname, resolveHost);
    if (!privateCheck.ok) return privateCheck;
  } else {
    // Even with allow_private_urls, the cloud-metadata IP is non-overridable
    // — the `isCloudMetadataHost` check above caught the literal '169.254.169.254',
    // and the resolveHost path below catches DNS-rebinding to it.
    const dnsRebindCheck = await checkResolvesToCloudMetadata(hostname, resolveHost);
    if (!dnsRebindCheck.ok) return dnsRebindCheck;
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Private-network detection
// ---------------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ip4ToInt(ip: string): number {
  return (
    ip
      .split('.')
      .reduce((acc: number, octet: string) => (acc << 8) | Number.parseInt(octet, 10), 0) >>> 0
  );
}

const PRIVATE_RANGES_V4: Array<{ start: number; end: number; label: string }> = [
  { start: ip4ToInt('0.0.0.0'), end: ip4ToInt('0.255.255.255'), label: 'unspecified' },
  { start: ip4ToInt('10.0.0.0'), end: ip4ToInt('10.255.255.255'), label: 'RFC1918' },
  { start: ip4ToInt('100.64.0.0'), end: ip4ToInt('100.127.255.255'), label: 'shared-address' },
  { start: ip4ToInt('127.0.0.0'), end: ip4ToInt('127.255.255.255'), label: 'loopback' },
  {
    start: ip4ToInt('169.254.0.0'),
    end: ip4ToInt('169.254.255.255'),
    label: 'link-local/metadata',
  },
  { start: ip4ToInt('172.16.0.0'), end: ip4ToInt('172.31.255.255'), label: 'RFC1918' },
  { start: ip4ToInt('192.168.0.0'), end: ip4ToInt('192.168.255.255'), label: 'RFC1918' },
  { start: ip4ToInt('224.0.0.0'), end: ip4ToInt('239.255.255.255'), label: 'multicast' },
  { start: ip4ToInt('240.0.0.0'), end: ip4ToInt('255.255.255.255'), label: 'reserved' },
];

function isValidIpv4(s: string): boolean {
  const m = s.match(IPV4_RE);
  return m?.slice(1).every((octet) => Number(octet) <= 255) ?? false;
}

function isPrivateIpv4(ip: string): boolean {
  if (!isValidIpv4(ip)) return false;
  const n = ip4ToInt(ip);
  return PRIVATE_RANGES_V4.some(({ start, end }) => n >= start && n <= end);
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped IPv6 ::ffff:x.x.x.x (textual)
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  // IPv4-mapped in normalized hex form ::ffff:c0a8:101
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    const a = (high >> 8) & 0xff;
    const b = high & 0xff;
    const c = (low >> 8) & 0xff;
    const d = low & 0xff;
    return isPrivateIpv4(`${a}.${b}.${c}.${d}`);
  }
  // IPv4-compatible IPv6 (deprecated but still parseable): ::a.b.c.d
  const compat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (compat) return isPrivateIpv4(compat[1]);
  return false;
}

function isPrivateIp(ip: string): boolean {
  return isPrivateIpv4(ip) || (ip.includes(':') && isPrivateIpv6(ip));
}

async function checkPrivate(
  hostname: string,
  resolveHost: (h: string) => Promise<string[]>,
): Promise<ValidateResult> {
  if (isPrivateIp(hostname)) {
    return { ok: false, reason: `host '${hostname}' is in a private/reserved range` };
  }
  if (!isLikelyIp(hostname)) {
    let addrs: string[];
    try {
      addrs = await resolveHost(hostname);
    } catch {
      return { ok: true };
    }
    for (const a of addrs) {
      if (isPrivateIp(a)) {
        return {
          ok: false,
          reason: `host '${hostname}' resolves to private IP '${a}'`,
        };
      }
    }
  }
  return { ok: true };
}

async function checkResolvesToCloudMetadata(
  hostname: string,
  resolveHost: (h: string) => Promise<string[]>,
): Promise<ValidateResult> {
  if (isLikelyIp(hostname)) return { ok: true };
  let addrs: string[];
  try {
    addrs = await resolveHost(hostname);
  } catch {
    return { ok: true };
  }
  for (const a of addrs) {
    if (isCloudMetadataHost(a)) {
      return {
        ok: false,
        reason: `host '${hostname}' resolves to cloud-metadata IP '${a}'`,
      };
    }
  }
  return { ok: true };
}

function isLikelyIp(s: string): boolean {
  return isValidIpv4(s) || s.includes(':');
}

// ---------------------------------------------------------------------------
// Auth header stripping on cross-origin redirects
// ---------------------------------------------------------------------------

const AUTH_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

/**
 * Remove credential-bearing headers from a HeadersInit value.
 * Called when a redirect crosses origins to prevent leaking API keys
 * or session tokens to third-party hosts.
 */
function stripAuthHeaders(headers: HeadersInit): HeadersInit {
  if (headers instanceof Headers) {
    const safe = new Headers(headers);
    for (const name of AUTH_HEADERS) safe.delete(name);
    return safe;
  }
  if (Array.isArray(headers)) {
    return headers.filter(([name]) => !AUTH_HEADERS.has(name.toLowerCase()));
  }
  // Record<string, string>
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!AUTH_HEADERS.has(key.toLowerCase())) {
      safe[key] = value;
    }
  }
  return safe;
}
