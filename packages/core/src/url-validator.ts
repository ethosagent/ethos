// Synchronous SSRF validator for configuration-time URL checks.
//
// This is the lightweight, synchronous complement to `@ethosagent/safety-network`'s
// async `validateUrl` (which includes DNS resolution). Use this for base-URL
// validation at construction time (LLM providers, webhook endpoints) where DNS
// resolution is inappropriate — the URL is a literal the operator typed.
//
// The async, DNS-resolving validator in `safety-network` handles runtime fetches
// via `ScopedFetchImpl` → `safeFetch`. This module catches the obvious cases
// (literal private IPs, non-http schemes, metadata hostnames) without network I/O.

import { isIP } from 'node:net';

// ---------------------------------------------------------------------------
// Private IP ranges (IPv4)
// ---------------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ip4ToInt(ip: string): number {
  return (
    ip
      .split('.')
      .reduce((acc: number, octet: string) => (acc << 8) | Number.parseInt(octet, 10), 0) >>> 0
  );
}

const PRIVATE_RANGES_V4: ReadonlyArray<{ start: number; end: number }> = [
  { start: ip4ToInt('0.0.0.0'), end: ip4ToInt('0.255.255.255') },
  { start: ip4ToInt('10.0.0.0'), end: ip4ToInt('10.255.255.255') },
  { start: ip4ToInt('100.64.0.0'), end: ip4ToInt('100.127.255.255') },
  { start: ip4ToInt('127.0.0.0'), end: ip4ToInt('127.255.255.255') },
  { start: ip4ToInt('169.254.0.0'), end: ip4ToInt('169.254.255.255') },
  { start: ip4ToInt('172.16.0.0'), end: ip4ToInt('172.31.255.255') },
  { start: ip4ToInt('192.168.0.0'), end: ip4ToInt('192.168.255.255') },
  { start: ip4ToInt('224.0.0.0'), end: ip4ToInt('239.255.255.255') },
  { start: ip4ToInt('240.0.0.0'), end: ip4ToInt('255.255.255.255') },
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

function isLoopbackIp(ip: string): boolean {
  if (ip.startsWith('127.')) return true;
  if (ip === '::1') return true;
  // IPv4-mapped ::ffff:127.x.x.x
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1].startsWith('127.')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Cloud metadata hostnames (always denied, non-overridable)
// ---------------------------------------------------------------------------

const CLOUD_METADATA_HOSTS: ReadonlySet<string> = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  'metadata.azure.com',
  'metadata.aws.amazon.com',
  'fd00:ec2::254',
  '100.100.100.200',
  '169.254.0.23',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ValidateUrlOptions {
  /** Allow requests to localhost/127.0.0.1 (default: false).
   *  Useful for local LLM providers like Ollama. */
  allowLocalhost?: boolean;
  /** Additional hosts to allow even if they resolve to private IPs. */
  trustedHosts?: string[];
}

export class SsrfError extends Error {
  constructor(url: string, reason: string) {
    super(`SSRF blocked: ${reason} (${url})`);
    this.name = 'SsrfError';
  }
}

/**
 * Synchronous SSRF validator. Checks:
 * 1. URL is well-formed
 * 2. Scheme is http or https
 * 3. No embedded credentials
 * 4. Hostname is not a cloud metadata endpoint
 * 5. If hostname is a literal IP, it must not be in a private range
 * 6. Hostname is not `localhost` or `.local` / `.internal`
 *
 * Does NOT perform DNS resolution — use `safeFetch` from `@ethosagent/safety-network`
 * for runtime fetches where DNS rebinding is a concern.
 */
export function validateUrl(urlStr: string, opts?: ValidateUrlOptions): URL {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new SsrfError(urlStr, 'invalid URL');
  }

  // Only allow http(s)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(urlStr, `scheme "${url.protocol.replace(':', '')}" not allowed`);
  }

  // Reject embedded credentials
  if (url.username || url.password) {
    throw new SsrfError(urlStr, 'URLs with embedded credentials are not allowed');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Check if host is a trusted override
  if (opts?.trustedHosts?.includes(hostname)) {
    return url;
  }

  // Cloud metadata — always denied, non-overridable
  if (CLOUD_METADATA_HOSTS.has(hostname)) {
    throw new SsrfError(urlStr, `cloud-metadata host "${hostname}" is always denied`);
  }

  // Check if hostname is a raw IP
  if (isIP(hostname)) {
    if (opts?.allowLocalhost && isLoopbackIp(hostname)) {
      return url;
    }
    if (isPrivateIp(hostname)) {
      throw new SsrfError(urlStr, 'private/internal IP address');
    }
  } else {
    // Hostname-based checks
    if (!opts?.allowLocalhost) {
      if (hostname === 'localhost' || hostname.endsWith('.local')) {
        throw new SsrfError(urlStr, 'localhost not allowed');
      }
    }
    if (hostname.endsWith('.internal')) {
      throw new SsrfError(urlStr, 'internal hostname not allowed');
    }
  }

  return url;
}
