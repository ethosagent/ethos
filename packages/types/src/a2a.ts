// @ethosagent/types — Agent-to-Agent (A2A) identity contracts.
//
// Zero-dep pure interfaces. The `AgentCard` is a projection of an existing
// personality (SOUL.md + config.yaml + toolset/skills) — NOT a second source
// of truth. It is produced by `A2aIdentityProvider.getIdentity`, which lives
// in the personalities extension; verification of a card lives later in
// `packages/a2a`. See plan/phases/a2a-implementation.md §6/§7/§8.

/**
 * Visibility tier for a card, set by the ADMIN. Combined by intersection with
 * per-skill owner visibility (a skill's `exposeToAgents` frontmatter flag):
 *
 * - `internal`      — full card: every one of the personality's skills.
 * - `trusted-peer`  — fuller subset: only skills flagged `exposeToAgents`.
 * - `stranger`      — minimal card: name + description headline, no skill list.
 */
export type AgentAudience = 'internal' | 'trusted-peer' | 'stranger';

/**
 * A single capability advertised on a card. Already audience-filtered by the
 * provider — a card never carries a skill the audience may not see.
 */
export interface AgentSkill {
  name: string;
  description: string;
}

/**
 * DID `verificationMethod` entry — the Ed25519 public key expressed in
 * DID-core terms. `publicKeyMultibase` is the `did:key` multibase form
 * (`z` + base58btc(multicodec-prefixed raw key)).
 */
export interface DidVerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020';
  controller: string;
  publicKeyMultibase: string;
}

/** DID `service` entry — points at the agent's JSON-RPC endpoint. */
export interface DidServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string;
}

/**
 * DID-compatible envelope carried alongside the A2A JSON (plan §8). Uses the
 * `did:key` method for v1: self-contained, no registry. The `id` is the
 * `did:key` identifier derived from the Ed25519 public key.
 */
export interface DidDocument {
  id: string;
  verificationMethod: DidVerificationMethod;
  service: DidServiceEndpoint[];
}

/**
 * The signed Agent Card — WHO the agent is, HOW to authenticate, HOW to talk,
 * and WHAT it can do (for this audience). Signed with the agent's Ed25519 key
 * over a deterministic serialization of every field EXCEPT `signature`.
 */
export interface AgentCard {
  /** Personality id — stable identifier. */
  id: string;
  name: string;
  /** Headline description (the identity line, from config or SOUL.md). */
  description: string;
  /** A2A protocol version, e.g. `"a2a/0.1"`. */
  protocolVersion: string;
  /** Capabilities visible to this audience (already filtered). */
  skills: AgentSkill[];
  /** Where to talk (JSON-RPC) and where to authenticate (handshake). */
  endpoints: { jsonRpc: string; auth: string };
  /** Raw Ed25519 public key, base64-encoded. */
  publicKey: string;
  /** Short hex sha256 of the raw public key — the out-of-band trust anchor. */
  keyFingerprint: string;
  signatureAlg: 'ed25519';
  /** base64 signature over the card's deterministic serialization (sans `signature`). */
  signature: string;
  /** DID-compatible envelope (plan §8). */
  did: DidDocument;
}

/**
 * Read-only projection of a personality into a signed `AgentCard`, filtered by
 * `audience`. A SEPARATE contract (not a `PersonalityRegistry` method) so A2A
 * stays isolable — nothing in the personality registry depends on A2A.
 *
 * Side-effect-free with respect to the personality; the implementation MAY
 * lazily bootstrap the agent's Ed25519 keypair in `SecretsResolver` on first
 * call (idempotent).
 */
export interface A2aIdentityProvider {
  getIdentity(personalityId: string, audience: AgentAudience): Promise<AgentCard>;
}
