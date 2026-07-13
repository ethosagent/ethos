// A2A peering service — the DRY trust core BOTH the CLI and the web-api RPC call
// (plan §4). The verify-fingerprint + default-deny + full-access(['*']) rules
// are written once here, so no surface can relax them. Lives in the composition
// layer (`packages/wiring`), so it may import `@ethosagent/a2a`,
// `@ethosagent/types`, and `extensions/personalities` — all allowed here.

import {
  type A2aAllowlistAdmin,
  A2aClientError,
  type A2aPeerStore,
  type A2aPeerStoreAdmin,
  fetchAndVerifyCard,
  StorageA2aAllowlist,
  StorageA2aPeerStore,
} from '@ethosagent/a2a';
import type { A2aIdentityProvider, AgentCard, Storage } from '@ethosagent/types';
import { isEthosError } from '@ethosagent/types';

/**
 * A peer row as the CLI/UI shows it — the allowlist grant joined with the peer
 * store's verified card. `access` is always `'full'` in v1 (scope `['*']`, §2a).
 */
export interface A2aPeerRow {
  fingerprint: string;
  /** Local display name (from the allowlist entry). */
  label?: string;
  /** The peer's self-reported name (from the peer store card). */
  cardName?: string;
  /** The peer's well-known URL (from the allowlist entry). */
  url?: string;
  /** v1 always full access, bounded by the owner's exposed skills (§2a). */
  access: 'full';
  enabled: boolean;
  /** ms epoch of the last inbound authenticated interaction; absent → never. */
  lastSeenAt?: number;
}

/**
 * The shareable identity of a personality — what you hand a peer out-of-band
 * (`a2a identity` + the UI identity panel).
 */
export interface A2aIdentityView {
  personalityId: string;
  name: string;
  fingerprint: string;
  wellKnownUrl: string;
  jsonRpcUrl: string;
  authUrl: string;
  did?: string;
  exposedSkills: string[];
}

/** Discriminated failure reasons surfaced to the CLI/RPC. */
export type A2aPeeringErrorCode =
  | 'fingerprint_mismatch'
  | 'fetch_failed'
  | 'invalid_card'
  | 'unknown_personality';

/** Typed error thrown by {@link A2aPeeringService}. */
export class A2aPeeringError extends Error {
  readonly code: A2aPeeringErrorCode;
  constructor(code: A2aPeeringErrorCode, message: string) {
    super(message);
    this.name = 'A2aPeeringError';
    this.code = code;
  }
}

/** Injected dependencies — nothing is reached for globally. */
export interface A2aPeeringServiceDeps {
  identity: A2aIdentityProvider;
  allowlist: A2aAllowlistAdmin;
  peers: A2aPeerStoreAdmin & A2aPeerStore;
  /** Injectable card fetch/verify for tests; defaults to the real one. */
  fetchCard?: typeof fetchAndVerifyCard;
  /** Injectable clock (ms epoch) for tests; defaults to `Date.now`. */
  now?: () => number;
}

/** Args for {@link A2aPeeringService.addPeer}. */
export interface AddPeerArgs {
  url: string;
  expectedFingerprint?: string;
  label?: string;
}

export class A2aPeeringService {
  // Field is named `identityProvider` (not `identity`) so it does not shadow the
  // public `identity()` method as an own instance property.
  private readonly identityProvider: A2aIdentityProvider;
  private readonly allowlist: A2aAllowlistAdmin;
  private readonly peers: A2aPeerStoreAdmin & A2aPeerStore;
  private readonly fetchCard: typeof fetchAndVerifyCard;

  constructor(deps: A2aPeeringServiceDeps) {
    this.identityProvider = deps.identity;
    this.allowlist = deps.allowlist;
    this.peers = deps.peers;
    this.fetchCard = deps.fetchCard ?? fetchAndVerifyCard;
  }

  /** "Who am I" — the shareable identity card, derived from the internal card. */
  async identity(personalityId: string): Promise<A2aIdentityView> {
    const internal = await this.getIdentityOrThrow(personalityId, 'internal');
    const trusted = await this.getIdentityOrThrow(personalityId, 'trusted-peer');
    const base = deriveBaseUrl(internal);
    const view: A2aIdentityView = {
      personalityId: internal.id,
      name: internal.name,
      fingerprint: internal.keyFingerprint,
      wellKnownUrl: `${base}/.well-known/agent-card.json?personality=${encodeURIComponent(internal.id)}`,
      jsonRpcUrl: internal.endpoints.jsonRpc,
      authUrl: internal.endpoints.auth,
      exposedSkills: trusted.skills.map((s) => s.name),
    };
    if (internal.did?.id) view.did = internal.did.id;
    return view;
  }

  /** Fetch + signature-verify a peer's card without writing anything. */
  async previewPeer(url: string): Promise<{ card: AgentCard; fingerprint: string }> {
    const card = await this.fetchVerified(url);
    return { card, fingerprint: card.keyFingerprint };
  }

  /**
   * The human-anchored, verify-first add flow (plan §2a). Verifies the card
   * against `expectedFingerprint` (if given), then writes a DISABLED allowlist +
   * peer entry granting FULL ACCESS (`scope: ['*']`). Nothing is written if the
   * verification fails.
   */
  async addPeer(personalityId: string, args: AddPeerArgs): Promise<A2aPeerRow> {
    const card = await this.fetchVerified(args.url, args.expectedFingerprint);
    const fingerprint = card.keyFingerprint;

    await this.allowlist.upsert(personalityId, {
      fingerprint,
      scope: ['*'],
      enabled: false,
      ...(args.label !== undefined ? { label: args.label } : {}),
      url: args.url,
    });
    await this.peers.upsert(personalityId, {
      fingerprint,
      card,
      scope: ['*'],
      enabled: false,
    });

    const row: A2aPeerRow = {
      fingerprint,
      cardName: card.name,
      url: args.url,
      access: 'full',
      enabled: false,
    };
    if (args.label !== undefined) row.label = args.label;
    return row;
  }

  /** Left-join the allowlist grants with the peer store's verified cards. */
  async listPeers(personalityId: string): Promise<A2aPeerRow[]> {
    const [grants, peers] = await Promise.all([
      this.allowlist.list(personalityId),
      this.peers.list(personalityId),
    ]);
    const peerByFp = new Map(peers.map((p) => [p.fingerprint, p]));
    return grants.map((g) => {
      const peer = peerByFp.get(g.fingerprint);
      const row: A2aPeerRow = {
        fingerprint: g.fingerprint,
        access: 'full',
        enabled: g.enabled,
      };
      if (g.label !== undefined) row.label = g.label;
      if (g.url !== undefined) row.url = g.url;
      if (peer?.card.name !== undefined) row.cardName = peer.card.name;
      if (peer?.lastSeenAt !== undefined) row.lastSeenAt = peer.lastSeenAt;
      return row;
    });
  }

  /**
   * Flip a peer's grant. On DISABLE (revoke), ALSO flip the peer entry to
   * `enabled: false` so any in-flight token is immediately rejected by
   * `validateToken`. On ENABLE, only the allowlist entry — the handshake
   * re-enables the peer entry on the next token mint.
   */
  async setEnabled(personalityId: string, fingerprint: string, enabled: boolean): Promise<void> {
    await this.allowlist.setEnabled(personalityId, fingerprint, enabled);
    if (!enabled) await this.denyPeerEntry(personalityId, fingerprint);
  }

  /**
   * Remove the allowlist grant (default-deny for future handshakes) and disable
   * any existing peer entry so an in-flight token is rejected now.
   */
  async removePeer(personalityId: string, fingerprint: string): Promise<void> {
    await this.allowlist.remove(personalityId, fingerprint);
    await this.denyPeerEntry(personalityId, fingerprint);
  }

  /**
   * Every skill the personality has (internal card), marked `exposed: true` when
   * it is also on the trusted-peer card (owner opt-in via `exposeToAgents`).
   * Read-only in v1 (plan §11).
   */
  async exposableSkills(personalityId: string): Promise<{ name: string; exposed: boolean }[]> {
    const internal = await this.getIdentityOrThrow(personalityId, 'internal');
    const trusted = await this.getIdentityOrThrow(personalityId, 'trusted-peer');
    const exposed = new Set(trusted.skills.map((s) => s.name));
    return internal.skills.map((s) => ({ name: s.name, exposed: exposed.has(s.name) }));
  }

  // -- internals ------------------------------------------------------------

  private async getIdentityOrThrow(
    personalityId: string,
    audience: 'internal' | 'trusted-peer',
  ): Promise<AgentCard> {
    try {
      return await this.identityProvider.getIdentity(personalityId, audience);
    } catch (err) {
      if (isEthosError(err) && err.code === 'PERSONALITY_NOT_FOUND') {
        throw new A2aPeeringError('unknown_personality', err.message);
      }
      throw err;
    }
  }

  private async fetchVerified(url: string, expectedFingerprint?: string): Promise<AgentCard> {
    try {
      return await this.fetchCard(
        url,
        expectedFingerprint !== undefined ? { expectedFingerprint } : {},
      );
    } catch (err) {
      if (err instanceof A2aClientError) {
        throw new A2aPeeringError(mapClientErrorCode(err.code), err.message);
      }
      throw err;
    }
  }

  /** Set a peer entry's `enabled` to false if it exists; no-op otherwise. */
  private async denyPeerEntry(personalityId: string, fingerprint: string): Promise<void> {
    const entry = await this.peers.get(personalityId, fingerprint);
    if (!entry?.enabled) return;
    await this.peers.upsert(personalityId, { ...entry, enabled: false });
  }
}

/** Factory over pre-built stores — the injection seam for tests + custom deps. */
export function createA2aPeeringService(deps: A2aPeeringServiceDeps): A2aPeeringService {
  return new A2aPeeringService(deps);
}

/** Context for {@link buildA2aPeeringService} — the shared A2A store roots. */
export interface BuildA2aPeeringServiceContext {
  storage: Storage;
  /** The A2A base dir, i.e. `<ethosDir>/a2a`. */
  baseDir: string;
  identity: A2aIdentityProvider;
}

/**
 * Build the service the SAME way for every surface (CLI, RPC, serve): the
 * allowlist + peer store are constructed over the shared `baseDir` so the UI and
 * the live `/a2a` handshake are ONE source of truth (plan §12).
 */
export function buildA2aPeeringService(ctx: BuildA2aPeeringServiceContext): A2aPeeringService {
  return new A2aPeeringService({
    identity: ctx.identity,
    allowlist: new StorageA2aAllowlist(ctx.storage, ctx.baseDir),
    peers: new StorageA2aPeerStore(ctx.storage, ctx.baseDir),
  });
}

/**
 * Derive the serve base URL from a card. The provider builds endpoints as
 * `${base}/a2a/<id>` and `${base}/a2a-auth/<id>`; stripping the known
 * `/a2a/<id>` suffix recovers `${base}` for the well-known URL.
 */
function deriveBaseUrl(card: AgentCard): string {
  const suffix = `/a2a/${card.id}`;
  const jsonRpc = card.endpoints.jsonRpc;
  return jsonRpc.endsWith(suffix) ? jsonRpc.slice(0, -suffix.length) : jsonRpc;
}

function mapClientErrorCode(code: A2aClientError['code']): A2aPeeringErrorCode {
  switch (code) {
    case 'fingerprint_mismatch':
      return 'fingerprint_mismatch';
    case 'fetch_failed':
      return 'fetch_failed';
    // A malformed body OR a bad signature both mean "not a trustworthy card".
    default:
      return 'invalid_card';
  }
}
