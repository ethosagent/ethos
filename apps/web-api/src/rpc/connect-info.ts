// Resolves the URL a phone should scan a QR code for (mobile-app plan S7,
// S13(b)) — the single owner of this precedence, shared by `meta.connectInfo`
// (this package) and `ethos api-key create --preset phone --qr` (imported
// from `@ethosagent/web-api`; `apps/ethos` already depends on this package,
// so this is not a layer violation). Precedence: `ETHOS_PUBLIC_URL` env >
// `webBaseUrl` config > `web.host`/port bind.
//
// `configWebBaseUrl` must be the value BEFORE `ETHOS_PUBLIC_URL` is folded
// in — `packages/config`'s own `EthosConfig.webBaseUrl` is already
// `process.env.ETHOS_PUBLIC_URL ?? kv.webBaseUrl`, which would make the two
// precedence branches indistinguishable. Callers reading via `ConfigService`
// are fine passing that already-merged value here: this function checks
// `env.ETHOS_PUBLIC_URL` FIRST and returns before ever consulting
// `configWebBaseUrl`, so if the env var was set, that branch fires first and
// attributes the source correctly regardless.

export interface ConnectInfoResult {
  url: string;
  source: 'ETHOS_PUBLIC_URL' | 'webBaseUrl' | 'web.host';
  loopback: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function resolveConnectInfo(opts: {
  env: NodeJS.ProcessEnv;
  configWebBaseUrl: string | null;
  webHost: string;
  webPort: number;
}): ConnectInfoResult {
  const publicUrl = opts.env.ETHOS_PUBLIC_URL;
  if (publicUrl) {
    return {
      url: publicUrl,
      source: 'ETHOS_PUBLIC_URL',
      loopback: LOOPBACK_HOSTS.has(hostnameOf(publicUrl)),
    };
  }
  if (opts.configWebBaseUrl) {
    return {
      url: opts.configWebBaseUrl,
      source: 'webBaseUrl',
      loopback: LOOPBACK_HOSTS.has(hostnameOf(opts.configWebBaseUrl)),
    };
  }
  // `0.0.0.0` is a bind-all wildcard, not a connect address — mirrors the
  // same substitution `ethos serve` already prints its own banner with
  // (`serve.ts`'s `displayHost`).
  const displayHost = opts.webHost === '0.0.0.0' ? 'localhost' : opts.webHost;
  return {
    url: `http://${displayHost}:${opts.webPort}`,
    source: 'web.host',
    loopback: LOOPBACK_HOSTS.has(displayHost),
  };
}
