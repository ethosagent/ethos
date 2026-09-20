import { type EthosClient, normalizeRemoteUrl, probeConnection, remoteHost } from '@ethosagent/sdk';
import { MIN_SERVER_VERSION, MINT_COMMAND, missingScopes, versionAtLeast } from '../api/scopes';
import type { RowData } from '../lib/row';

// The Connect screen's two probes (§1, D2), as feedback rows. `/healthz` is
// unauthenticated — 200 or 503 both mean an Ethos server answered — and
// `meta.whoami` needs a valid key and no scope, so it proves the key EXISTS
// and says what it can do. Whether it can do ENOUGH is `refusals`.

export const PROBE_TIMEOUT_MS = 5_000;

export type Whoami = Awaited<ReturnType<EthosClient['rpc']['meta']['whoami']>>;

export function waiting(subject: string): RowData {
  return { glyph: '·', word: 'probe', subject, result: '… · waiting' };
}

export interface HealthProbe {
  ok: boolean;
  row: RowData;
  version: string | null;
}

export async function probeHealth(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<HealthProbe> {
  const res = await probeConnection(url, { fetch: fetchFn, timeoutMs: PROBE_TIMEOUT_MS });
  if (!res.ok) {
    const host = remoteHost(url) ?? url;
    return {
      ok: false,
      version: null,
      row: { glyph: '✗', word: 'probe', subject: host, result: unreachable(url, res.error ?? '') },
    };
  }
  const version = res.version ?? null;
  return {
    ok: true,
    version,
    row: {
      glyph: '✓',
      word: 'probe',
      subject: 'GET /healthz',
      result: version ? `v${version}` : 'version · unknown',
      time: `${res.latencyMs ?? 0} ms`,
    },
  };
}

/**
 * React Native's fetch rejects cleartext, a declined Local Network prompt, an
 * untrusted certificate and a refused connection alike, with no code — so the
 * row picks the fix from the host's shape and the message text (§1). The
 * message patterns are iOS's NSURLError strings and are unverified on a device.
 */
export function unreachable(url: string, error: string): string {
  const origin = normalizeRemoteUrl(url);
  if (!origin) return error;
  const { protocol, hostname } = new URL(origin);
  const local = isLocalHost(hostname);
  if (protocol === 'https:' && /certificate|ssl|trust/i.test(error))
    return 'certificate not trusted';
  if (protocol === 'http:' && !local && !/^[\d.]+$|:/.test(hostname)) {
    return "cleartext blocked · use https, or the app's ATS exemption";
  }
  if (local && /offline|not connected/i.test(error)) {
    return 'local network denied · allow Local Network for Ethos in iOS Settings';
  }
  return 'connection refused · nothing is listening — check web.host';
}

/** `.local`, a single-label name, or an RFC 1918 / link-local / CGNAT (tailnet) IPv4. */
export function isLocalHost(hostname: string): boolean {
  if (hostname.endsWith('.local') || !hostname.includes('.')) return true;
  const ip = hostname.split('.').map(Number);
  if (ip.length !== 4 || ip.some((n) => !Number.isInteger(n))) return false;
  const [a = 0, b = 0] = ip;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export interface WhoamiProbe {
  ok: boolean;
  row: RowData;
  scopes: string[];
}

export async function probeWhoami(
  call: () => Promise<Whoami>,
  ctx: { host: string; version: string | null },
): Promise<WhoamiProbe> {
  const subject = 'meta.whoami';
  try {
    const me = await call();
    const key = me.authMethod === 'bearer' ? me.key : null;
    const scopes: string[] = key?.scopes ?? [];
    const name = key?.name ?? me.authMethod;
    return {
      ok: true,
      scopes,
      row: {
        glyph: '✓',
        word: 'probe',
        subject,
        result: `bearer · ${name} · scopes ${scopes.join(', ') || 'none'}`,
      },
    };
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? err.code : undefined;
    const result =
      code === 'UNAUTHORIZED'
        ? 'key invalid or revoked'
        : code === 'FORBIDDEN' || code === 'NOT_FOUND'
          ? tooOld(ctx.version, ctx.host)
          : err instanceof Error
            ? err.message
            : String(err);
    return { ok: false, scopes: [], row: { glyph: '✗', word: 'probe', subject, result } };
  }
}

function tooOld(version: string | null, host: string): string {
  return version
    ? `needs ≥ ${MIN_SERVER_VERSION} · this server is ${version} · update ethos on ${host}`
    : 'server too old · update ethos';
}

/** Why Connect stays refused although both probes answered: an old server or
 *  a key minted without the phone's scopes (§1). Empty means go. */
export function refusals(scopes: string[], version: string | null, host: string): RowData[] {
  const rows: RowData[] = [];
  if (version && !versionAtLeast(version, MIN_SERVER_VERSION)) {
    rows.push({ glyph: '✗', word: 'server', subject: host, result: tooOld(version, host) });
  }
  const missing = missingScopes(scopes);
  if (missing.length > 0) {
    rows.push({
      glyph: '✗',
      word: 'scopes',
      subject: `missing ${missing.join(', ')}`,
      result: `mint a phone key: Settings → Mobile app on the web, or ${MINT_COMMAND}`,
    });
  }
  return rows;
}
