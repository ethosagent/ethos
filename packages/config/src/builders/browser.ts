import type { EthosConfig } from '../config-types';
import { parseBoundedInt } from './utils';

/** Bounds of `mcp.discoveryConcurrency`; the default (4) lives in `@ethosagent/tools-mcp`
 * (`DEFAULT_DISCOVERY_CONCURRENCY`); the copy below only words the warning. */
const MCP_DISCOVERY_CONCURRENCY_MIN = 1;
const MCP_DISCOVERY_CONCURRENCY_MAX = 16;
const MCP_DISCOVERY_CONCURRENCY_DEFAULT = 4;

/**
 * `mcp.discoveryConcurrency` from the flat `mcp.<field>` keys: an integer from
 * 1 to 16. Anything else is dropped with a warning and the field stays unset,
 * so the manager uses its default. Pinned by __tests__/config-mcp-discovery.test.ts.
 */
export function buildMcpConfig(kv: Record<string, string>): {
  mcp: EthosConfig['mcp'] | undefined;
  warnings: string[];
} {
  const raw = kv.discoveryConcurrency;
  if (raw === undefined) return { mcp: undefined, warnings: [] };
  const n = parseBoundedInt(raw, MCP_DISCOVERY_CONCURRENCY_MIN, MCP_DISCOVERY_CONCURRENCY_MAX);
  if (n === undefined) {
    return {
      mcp: undefined,
      warnings: [
        `mcp.discoveryConcurrency must be an integer from ${MCP_DISCOVERY_CONCURRENCY_MIN} to ${MCP_DISCOVERY_CONCURRENCY_MAX}; using the default (${MCP_DISCOVERY_CONCURRENCY_DEFAULT})`,
      ],
    };
  }
  return { mcp: { discoveryConcurrency: n }, warnings: [] };
}

/**
 * Tool-loop hard caps and soft-warn tiers from the flat `toolLoop.<field>`
 * keys. Positive integers — `0` would nudge on every turn before a single tool
 * ran (or stop the turn before it), which is a typo, not a setting. A warn tier
 * at or above its hard cap can never fire (the cap halts the turn first), so it
 * is dropped and the cap kept. Returns `undefined` when nothing survives,
 * leaving the loop with its defaults and no warn tier at all.
 */
export function buildToolLoop(kv: Record<string, string>): EthosConfig['toolLoop'] | undefined {
  const result: NonNullable<EthosConfig['toolLoop']> = {};
  for (const key of [
    'maxToolCallsWarnAt',
    'maxIdenticalToolCallsWarnAt',
    'maxToolCallsPerTurn',
    'maxIdenticalToolCalls',
  ] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) result[key] = Math.floor(n);
  }
  for (const [warn, cap] of [
    ['maxToolCallsWarnAt', 'maxToolCallsPerTurn'],
    ['maxIdenticalToolCallsWarnAt', 'maxIdenticalToolCalls'],
  ] as const) {
    const w = result[warn];
    const c = result[cap];
    if (w !== undefined && c !== undefined && w >= c) delete result[warn];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Proxy schemes Playwright accepts. */
const BROWSER_PROXY_SCHEMES = new Set(['http:', 'https:', 'socks4:', 'socks5:']);

/**
 * Why `browser.proxy.server` is an ENDPOINT and not a URL with room in it.
 *
 * `http://user:pass@proxy.example:3128` is the form most proxy documentation
 * uses, and it is the one form that must not be accepted: the password would
 * sit in `config.yaml` in plaintext, come back unredacted on every read of
 * `proxy.server`, and route around the `${secrets:...}` vaulting that
 * `browser.proxy.password` exists for. So userinfo, path, query and fragment
 * are all refused, and the two credential fields are the only way in. The
 * message says WHERE the credentials belong, because an operator who wrote the
 * URL form needs the next step, not a refusal. The offending value is never
 * echoed — it is the credential.
 */
const BROWSER_PROXY_ENDPOINT_ONLY =
  'must be an endpoint only — scheme, host and port, e.g. http://proxy.example.com:3128. ' +
  'A username, password, path, query or fragment in the URL is refused: put credentials in ' +
  'browser.proxy.username and browser.proxy.password, which are vaulted in the secret store ' +
  'instead of written into config.yaml in plaintext.';

/**
 * What is wrong with a proxy endpoint, or `null` when nothing is.
 *
 * - `'scheme'` — no usable `http`/`https`/`socks4`/`socks5` scheme or no host.
 *   A bare `host:port` lands here rather than being guessed at: `new
 *   URL('myproxy:3128')` happily parses `myproxy:` as the scheme, so guessing
 *   would accept a string that points nowhere and every request would go
 *   direct.
 * - `'endpoint'` — parses and points somewhere, but carries credentials or
 *   trailing parts. See {@link BROWSER_PROXY_ENDPOINT_ONLY}.
 *
 * MIRRORED by `browserProxyServerProblem` in
 * `apps/web-api/src/services/config.service.ts`, which cannot import this
 * module across the layer boundary. The two must change together.
 */
function browserProxyServerProblem(value: string): 'scheme' | 'endpoint' | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'scheme';
  }
  if (!BROWSER_PROXY_SCHEMES.has(u.protocol) || u.hostname.length === 0) return 'scheme';
  if (u.username !== '' || u.password !== '') return 'endpoint';
  if (u.search !== '' || u.hash !== '') return 'endpoint';
  // `''` for a non-special scheme (socks4/socks5), `'/'` for http(s).
  if (u.pathname !== '' && u.pathname !== '/') return 'endpoint';
  return null;
}

/**
 * A `browser.*` boolean. Strictly `true`/`false` and FATAL otherwise — see
 * {@link buildBrowser}'s header for why these are not dropped.
 */
function parseBrowserFlag(
  label: string,
  raw: string | undefined,
  errors: string[],
): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  errors.push(`${label}: invalid value '${raw}' (expected true or false).`);
  return undefined;
}

/**
 * The `browser.*` block, from flat keys (nested ones under their dotted
 * sub-path). Two validation strictnesses, deliberately:
 *
 * - The three `*Ms` budgets are BOUNDED NUMBERS, and an out-of-range value is
 *   dropped, leaving the call sites on their built-in defaults. That is the
 *   idiom the two timeouts shipped with, and the fallback is the value the
 *   operator was already running — nothing changes behind their back.
 * - `headed`, the two `enabled` flags and the whole `proxy` block are FATAL
 *   when malformed. For these there is no "out of range": `headed: flase` or
 *   `proxy.server: myproxy:3128` is an operator STATING an intent, and
 *   quietly substituting the framework default for it is exactly how a proxy
 *   the operator believed was carrying their traffic ends up not carrying it.
 *   A fail-open proxy is a de-anonymization leak, so boot refuses instead.
 *
 * Timeout bounds are 1s–10min: below a second no page load completes, and past
 * ten minutes the tool's own result budget has long since become the real
 * limit. `idleTimeoutMs` is 1min–24h: under a minute the sweeper would reap a
 * session between two tool calls of the same turn, and past a day an open
 * session is a leak rather than a cache.
 *
 * Returns no `browser` at all when a fatal error was found, exactly like
 * {@link buildGrounding} — `loadConfigStrict` exits non-zero on the error, and
 * the lenient `readRawConfig` callers fall back to the built-in defaults.
 */
export function buildBrowser(kv: Record<string, string>): {
  browser?: EthosConfig['browser'];
  errors: string[];
} {
  if (Object.keys(kv).length === 0) return { errors: [] };
  const errors: string[] = [];
  const result: NonNullable<EthosConfig['browser']> = {};

  for (const key of ['navigationTimeoutMs', 'commandTimeoutMs'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = parseBoundedInt(raw, 1_000, 600_000);
    if (n !== undefined) result[key] = n;
  }
  const idle = kv.idleTimeoutMs;
  if (idle !== undefined) {
    const n = parseBoundedInt(idle, 60_000, 86_400_000);
    if (n !== undefined) result.idleTimeoutMs = n;
  }

  // Three-state, and carried through verbatim: `'auto'` is resolved by the
  // session factory, which is the only layer that may probe this machine.
  const headed = kv.headed;
  if (headed === 'auto') result.headed = 'auto';
  else if (headed === 'true') result.headed = true;
  else if (headed === 'false') result.headed = false;
  else if (headed !== undefined) {
    errors.push(`browser.headed: invalid value '${headed}' (expected one of: true, false, auto).`);
  }

  const stealth = parseBrowserFlag('browser.stealth.enabled', kv['stealth.enabled'], errors);
  if (stealth !== undefined) result.stealth = { enabled: stealth };
  const profiles = parseBrowserFlag('browser.profiles.enabled', kv['profiles.enabled'], errors);
  if (profiles !== undefined) result.profiles = { enabled: profiles };

  const server = kv['proxy.server'];
  const username = kv['proxy.username'];
  const password = kv['proxy.password'];
  if (server !== undefined) {
    const problem = browserProxyServerProblem(server);
    if (problem === null) {
      result.proxy = {
        server,
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
      };
    } else if (problem === 'scheme') {
      errors.push(
        `browser.proxy.server: invalid value '${server}' (expected a URL with an http, ` +
          `https, socks4 or socks5 scheme, e.g. http://proxy.example.com:3128).`,
      );
    } else {
      // Deliberately does NOT echo `server`: this is the branch a URL carrying
      // an embedded password lands in.
      errors.push(`browser.proxy.server: ${BROWSER_PROXY_ENDPOINT_ONLY}`);
    }
  } else if (username !== undefined || password !== undefined) {
    // Credentials with nowhere to go. The operator believes a proxy is
    // configured and there is none — the fail-open case this block refuses.
    // Neither value is echoed: one of them is a credential.
    errors.push(
      'browser.proxy.username/password: set without browser.proxy.server. ' +
        'Add browser.proxy.server, or remove the credentials.',
    );
  }

  if (errors.length > 0) return { errors };
  return { ...(Object.keys(result).length > 0 ? { browser: result } : {}), errors: [] };
}
