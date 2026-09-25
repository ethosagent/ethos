// A2A outbound egress (plan openclaw-2026.9.6-gaps S7). Every request the
// outbound path issues — the agent-card fetch, the auth handshake POSTs, the
// `message/send` POST — goes through `a2aFetch`, which is `safeFetch` from
// `@ethosagent/safety-network`: scheme gate, cloud-metadata always-deny,
// private/reserved ranges unless the personality's `safety.network`
// opts in with `allow_private_urls`, the allow/deny lists, every redirect hop
// re-validated, and the connection pinned to the validated address. `peer_url`
// is model-chosen and the card's endpoints are peer-chosen, so none of them is
// trusted to point somewhere public.
//
// There is no plain-`fetch` path. An injected `fetchImpl` (tests) is still
// validated first — it only loses the connection pinning, exactly as
// `safeFetch` documents for its own seam.
//
// Layering: `packages/a2a` carries no §II layer (tier 2, .architecture-state.yaml);
// `@ethosagent/safety-network` is security-kernel, which depends on contracts
// only, so this import flows downward — the same edge `extensions/tools-web`
// and `extensions/tools-mcp` already have.

import { type NetworkPolicy, safeFetch } from '@ethosagent/safety-network';

export type { NetworkPolicy };

/** Knobs shared by the card fetch and the outbound client. */
export interface A2aEgressOptions {
  /** The acting personality's `safety.network` block. Absent → `{}` (public internet only). */
  networkPolicy?: NetworkPolicy;
  /** Test seam: validated, but NOT connection-pinned (see `safeFetch`). */
  fetchImpl?: typeof fetch;
  /** Test seam: DNS resolver for the private-range check. Default `node:dns` lookup. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

/**
 * The generic refusal text handed back to the model. Deliberately carries no
 * probe result: `safeFetch`'s own reason can name the address an internal
 * hostname resolved to, which is exactly what a probing model wants to learn.
 */
export const A2A_URL_REFUSED_MESSAGE =
  "refused by this personality's network policy (cloud-metadata, private or reserved address, " +
  'or a host outside safety.network allow/deny). A peer on a private network needs ' +
  'safety.network.allow_private_urls: true.';

/** Thrown by {@link a2aFetch} when the network policy refuses a URL (any hop). */
export class A2aUrlRefusedError extends Error {
  readonly code = 'url_refused' as const;
  constructor() {
    super(A2A_URL_REFUSED_MESSAGE);
    this.name = 'A2aUrlRefusedError';
  }
}

// `safeFetch` reports a transport failure (the underlying fetch threw —
// connection refused, a timeout's abort) as `{ ok:false, reason: 'fetch failed: …' }`,
// and every policy refusal with any other reason. The outbound client retries
// transport failures (plan T1.3) and must never retry a refusal, so the two are
// told apart here. Pinned by the retry cases in `outbound-idempotency-retry.test.ts`
// (transport) and `client.test.ts` "network policy (S7)" (refusal).
const TRANSPORT_FAILURE_PREFIX = 'fetch failed: ';

/**
 * Issue one A2A request through `safeFetch`. Resolves with the response of the
 * final hop; throws {@link A2aUrlRefusedError} on a policy refusal and a plain
 * `Error` (the transport reason) on a transport failure.
 */
export async function a2aFetch(
  url: string,
  init: Omit<RequestInit, 'redirect'>,
  opts: A2aEgressOptions,
): Promise<Response> {
  const result = await safeFetch(url, {
    policy: opts.networkPolicy ?? {},
    init,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.resolveHost ? { resolveHost: opts.resolveHost } : {}),
  });
  if (result.ok) return result.response;
  if (result.reason.startsWith(TRANSPORT_FAILURE_PREFIX)) {
    throw new Error(result.reason.slice(TRANSPORT_FAILURE_PREFIX.length));
  }
  throw new A2aUrlRefusedError();
}
