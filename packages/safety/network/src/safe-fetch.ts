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
// **DNS rebinding — connection pinning on the default path.** `validateUrl`
// resolves the hostname once and validates every returned address. When the
// caller does NOT inject `fetchImpl`, the request is issued by `pinnedFetch`:
// undici's own `fetch` with a per-request `Agent` whose `connect.lookup`
// answers ONLY with the addresses that validation accepted, so the socket
// connects to an address that was checked — there is no second resolution for
// a TTL-flipping attacker to win. The hostname still drives the Host header,
// TLS SNI and certificate verification; only the address is fixed. Each
// redirect hop re-runs `validateUrl` and gets its own pinned `Agent`. A host
// whose resolution failed during validation has no validated address, so its
// connect fails rather than falling back to the system resolver. Pinned by
// `__tests__/safe-fetch.test.ts` ("connection pinning").
//
// Limits, stated rather than implied:
//   - An injected `fetchImpl` is NOT pinned: it receives the URL and resolves
//     however it likes. The one production caller that injects one is the
//     vision input resolver's `ctx.fetchImpl` test seam
//     (extensions/tools-vision/src/input-resolver.ts); every other caller
//     takes the default and is pinned.
//   - Only `safeFetch` pins. `web_fetch` / `web_extract` use their own SSRF
//     check (extensions/tools-web/src/ssrf.ts) and remain exposed to the
//     rebinding race; that is the separate third-party HTTP client survey.
//   - One `Agent` per request forgoes keep-alive. Accepted: `safeFetch`
//     callers (OAuth, scope probes, vision URL fetches, the model catalog)
//     are low-volume.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { isCloudMetadataHost } from './cloud-metadata';
import { checkAllowDeny, type NetworkPolicy } from './policy';
import { checkScheme } from './scheme';

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true });
  return records.map((r) => r.address);
}

export interface SafeFetchOptions {
  policy: NetworkPolicy;
  /** Underlying fetch implementation; injected for testability. When set,
   *  the connection is NOT pinned to the validated addresses (see the module
   *  header) — the default path (`pinnedFetch`) is. */
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
  const fetchImpl = opts.fetchImpl;
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
      response = fetchImpl
        ? await fetchImpl(url, { ...init, redirect: 'manual' })
        : await pinnedFetch(url, { ...init, redirect: 'manual' }, policyCheck.addresses ?? []);
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
  /** The resolved addresses validation accepted — what `pinnedFetch` pins the
   *  connection to. Absent for an IP-literal host (nothing to resolve) and
   *  when resolution failed (nothing validated, so nothing to connect to). */
  addresses?: string[];
}

/**
 * Issue one request with its connection pinned to `addresses` — the addresses
 * `validateUrl` resolved and accepted for this URL's host. undici's own
 * `fetch` (not the runtime's global one, whose bundled `Agent` is not
 * exposed) with a per-request `Agent` whose `connect.lookup` never consults
 * DNS. An IP-literal host never reaches `lookup` (node:net connects to a
 * literal directly), and a hostname with no validated address fails to
 * connect instead of resolving again.
 */
async function pinnedFetch(
  url: string,
  init: RequestInit,
  addresses: readonly string[],
): Promise<Response> {
  const agent = new Agent({ connect: { lookup: pinnedLookup(addresses) } });
  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    // undici's RequestInit/Response are the same WHATWG shapes as the global
    // ones under separate declarations; the casts bridge the two type trees.
    response = await undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    });
  } catch (err) {
    await agent.destroy();
    throw err;
  }
  // Graceful close: the in-flight response body is still delivered; the agent
  // releases its socket once the body is consumed or discarded.
  void agent.close();
  return response as unknown as Response;
}

/**
 * node:net `lookup` answering only from `addresses`. Verified against Node 24
 * + undici 7.28: undici passes `connect` options through to `net.connect` /
 * `tls.connect`, which call `lookup(hostname, { all: true, hints })` under the
 * default `autoSelectFamily` (callback takes an address array) and
 * `lookup(hostname, { hints })` without it (callback takes address, family).
 */
function pinnedLookup(addresses: readonly string[]): LookupFunction {
  return (hostname, options, callback) => {
    const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
    const records = addresses
      .map((address) => ({ address, family: isIP(address) }))
      .filter((r) => r.family !== 0 && (wanted === 0 || r.family === wanted));
    const first = records[0];
    if (!first) {
      const err: NodeJS.ErrnoException = new Error(
        `no validated address to connect to for '${hostname}'`,
      );
      err.code = 'ENOTFOUND';
      callback(err, '', 0);
      return;
    }
    if (options.all) callback(null, records);
    else callback(null, first.address, first.family);
  };
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

  // Each branch resolves once and, on success, carries the accepted
  // `addresses` — what `pinnedFetch` pins the connection to.
  if (!policy.allow_private_urls) {
    return checkPrivate(hostname, resolveHost);
  }
  // Even with allow_private_urls, the cloud-metadata IP is non-overridable
  // — the `isCloudMetadataHost` check above caught the literal '169.254.169.254',
  // and the resolveHost path below catches DNS-rebinding to it.
  return checkResolvesToCloudMetadata(hostname, resolveHost);
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
    return { ok: true, addresses: addrs };
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
  return { ok: true, addresses: addrs };
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
