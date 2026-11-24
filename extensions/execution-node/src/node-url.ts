/** URL policy and reconnect backoff for the node client (plan §4 Replay row, D15). */

export class NodeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeUrlError';
  }
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '[::1]' || h === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Maps an http(s)/ws(s) server URL to the ws(s) URL of `path`. TLS is required for every host that
 * is not loopback (localhost, 127.0.0.0/8, ::1); pinned by __tests__/node-client.test.ts.
 */
export function assertSecureNodeUrl(raw: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NodeUrlError(`not a valid URL: ${raw}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new NodeUrlError(
      'refusing a URL with embedded credentials (the node key is the only secret)',
    );
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const plain = url.protocol === 'http:' || url.protocol === 'ws:';
  if (!secure && !plain) {
    throw new NodeUrlError(`unsupported URL scheme '${url.protocol}' (use https://)`);
  }
  if (plain && !isLoopbackHost(url.hostname)) {
    throw new NodeUrlError(
      `refusing cleartext connection to '${url.hostname}': use https:// for any host that is not loopback`,
    );
  }
  url.protocol = secure ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  url.search = '';
  url.hash = '';
  return url;
}

/**
 * Reconnect delay with jitter: doubles from `initialMs` up to `maxMs`, then a uniform pick between
 * `initialMs` and that ceiling, so a fleet of laptops does not reconnect in lockstep. Always within
 * [initialMs, maxMs]. `random` is injectable for tests (node-client.test.ts "nextBackoffMs").
 */
export function nextBackoffMs(
  attempt: number,
  random: () => number = Math.random,
  initialMs = 1000,
  maxMs = 60_000,
): number {
  const ceiling = Math.min(initialMs * 2 ** Math.max(0, attempt), maxMs);
  return Math.round(initialMs + random() * (ceiling - initialMs));
}
