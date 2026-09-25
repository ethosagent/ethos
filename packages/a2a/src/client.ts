// A2A outbound client — fetch a remote agent's well-known card and VERIFY it
// before trusting a single field (plan §7/§11). Two checks, both mandatory:
//
//   (a) card signature — the card genuinely came from the key it carries
//       (Ed25519 over the canonical form, sans `signature`), via `verifyCard`.
//   (b) fingerprint anchor — when the caller passes the out-of-band
//       `expectedFingerprint` (the §7 trust anchor obtained during peering),
//       it MUST match the card's key fingerprint. A valid signature over the
//       WRONG key is still a stranger's card; the fingerprint is what binds the
//       card to the peer a human approved.
//
// Verification lives here (a `packages/a2a` concern per §7), never in a skill.
//
// The fetch itself goes through `a2aFetch` (./egress): `wellKnownUrl` is
// model-chosen, so a metadata / private / reserved host is refused BEFORE any
// request, with a refusal that echoes no probe result (plan
// openclaw-2026.9.6-gaps S7; pinned by `client.test.ts` "network policy (S7)").

import type { AgentCard } from '@ethosagent/types';
import { verifyCard } from './crypto';
import { type A2aEgressOptions, A2aUrlRefusedError, a2aFetch } from './egress';

/** Discriminated failure reasons for a card fetch + verify. */
export type A2aClientErrorCode =
  | 'url_refused'
  | 'fetch_failed'
  | 'invalid_card'
  | 'bad_signature'
  | 'fingerprint_mismatch';

/** Typed error thrown by {@link fetchAndVerifyCard}. */
export class A2aClientError extends Error {
  readonly code: A2aClientErrorCode;
  constructor(code: A2aClientErrorCode, message: string) {
    super(message);
    this.name = 'A2aClientError';
    this.code = code;
  }
}

export interface FetchAndVerifyCardOptions extends A2aEgressOptions {
  /**
   * The out-of-band key fingerprint (plan §7 trust anchor). When supplied, the
   * fetched card's `keyFingerprint` MUST equal it, or a `fingerprint_mismatch`
   * is thrown. Omit only for a first, un-anchored fetch.
   */
  expectedFingerprint?: string;
}

/**
 * Fetch the card at `wellKnownUrl`, verify its signature (and fingerprint when
 * anchored), and return the verified `AgentCard`. Throws a typed
 * {@link A2aClientError} on a network-policy refusal (`url_refused`), fetch
 * failure, a malformed body, a bad signature, or a fingerprint mismatch.
 */
export async function fetchAndVerifyCard(
  wellKnownUrl: string,
  opts: FetchAndVerifyCardOptions = {},
): Promise<AgentCard> {
  let response: Response;
  try {
    response = await a2aFetch(wellKnownUrl, {}, opts);
  } catch (err) {
    if (err instanceof A2aUrlRefusedError) {
      throw new A2aClientError('url_refused', `Card URL ${err.message}`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new A2aClientError(
      'fetch_failed',
      `Failed to fetch card from ${wellKnownUrl}: ${reason}`,
    );
  }
  if (!response.ok) {
    throw new A2aClientError(
      'fetch_failed',
      `Card fetch from ${wellKnownUrl} returned HTTP ${response.status}.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new A2aClientError('invalid_card', `Card at ${wellKnownUrl} is not valid JSON.`);
  }
  if (!isAgentCardShape(body)) {
    throw new A2aClientError('invalid_card', `Card at ${wellKnownUrl} is missing required fields.`);
  }

  if (!verifyCard(body)) {
    throw new A2aClientError(
      'bad_signature',
      `Card at ${wellKnownUrl} failed signature verification.`,
    );
  }

  const expected = opts.expectedFingerprint;
  if (expected && expected !== body.keyFingerprint) {
    throw new A2aClientError(
      'fingerprint_mismatch',
      `Card fingerprint ${body.keyFingerprint} does not match the expected anchor ${expected}.`,
    );
  }

  return body;
}

/**
 * Minimal structural guard for a fetched card. External JSON is never cast with
 * `as` (project rule) — the fields `verifyCard` dereferences (`publicKey`,
 * `keyFingerprint`, `signature`) must exist as strings before crypto runs;
 * cryptographic verification does the rest.
 */
function isAgentCardShape(value: unknown): value is AgentCard {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.publicKey === 'string' &&
    typeof v.keyFingerprint === 'string' &&
    typeof v.signature === 'string' &&
    typeof v.id === 'string'
  );
}
