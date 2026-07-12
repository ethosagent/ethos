// A2A auth stores — the injected boundaries the handshake reasons over (plan
// §9). Three interfaces, each with a simple default implementation:
//
//   - NonceStore     — single-use, TTL-bounded challenge nonces (in-memory).
//   - A2aAllowlist   — the human-anchored trust gate (default-deny).
//   - A2aPeerStore   — runtime peer entries (card + scope + tokenRef + enabled).
//
// They are INTERFACES so the real per-personality-config source (plan §5.5) can
// replace the defaults in a later phase without touching the handshake. The
// defaults depend only on `@ethosagent/types` (`Storage`) + `node:crypto` — no
// extensions, no apps (plan §2 layer model).

import { randomBytes } from 'node:crypto';
import type { AgentCard, Storage } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Nonce store
// ---------------------------------------------------------------------------

/** What a stored nonce is bound to. */
export interface NonceRecord {
  expiresAt: number;
  targetAgentId: string;
}

/**
 * A single-use challenge-nonce store (plan §0A / §9). `issue` mints a fresh
 * crypto-random nonce bound to a target agent; `consume` returns and DELETES it
 * (single-use) iff it exists and is unexpired, else null. A replayed or expired
 * nonce yields null and is rejected by the handshake.
 */
export interface NonceStore {
  issue(targetAgentId: string): string;
  consume(nonce: string): NonceRecord | null;
}

export interface MemoryNonceStoreOptions {
  /** Nonce TTL in ms. Default 60_000 (plan §0A: short, 30–60s). */
  ttlMs?: number;
  /** Max live nonces before oldest-first eviction. Default 10_000. */
  maxSize?: number;
  /** Injectable clock (ms epoch) for testing expiry. Default `Date.now`. */
  now?: () => number;
}

/**
 * In-process nonce store (plan §9: "in-process map for v1, per the single-
 * process assumption; note it must move to shared storage if the server scales
 * out"). Single-use, TTL-bounded, size-capped with oldest-first eviction, swept
 * on issue. Injected as a {@link NonceStore} so it can later move to shared
 * storage without touching the handshake.
 */
export class MemoryNonceStore implements NonceStore {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly now: () => number;
  // Insertion-ordered Map — first key is the oldest, so eviction is O(1).
  private readonly nonces = new Map<string, NonceRecord>();

  constructor(opts: MemoryNonceStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.maxSize = opts.maxSize ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  issue(targetAgentId: string): string {
    this.sweep();
    if (this.nonces.size >= this.maxSize) {
      const oldest = this.nonces.keys().next().value;
      if (oldest !== undefined) this.nonces.delete(oldest);
    }
    const nonce = randomBytes(32).toString('base64url');
    this.nonces.set(nonce, { expiresAt: this.now() + this.ttlMs, targetAgentId });
    return nonce;
  }

  consume(nonce: string): NonceRecord | null {
    const record = this.nonces.get(nonce);
    if (!record) return null;
    // Single-use: delete on lookup regardless of expiry, so an expired entry
    // cannot linger to be retried.
    this.nonces.delete(nonce);
    if (record.expiresAt <= this.now()) return null;
    return record;
  }

  private sweep(): void {
    const cutoff = this.now();
    for (const [nonce, record] of this.nonces) {
      if (record.expiresAt <= cutoff) this.nonces.delete(nonce);
    }
  }
}

// ---------------------------------------------------------------------------
// Allowlist — the human-anchored trust gate (default-deny)
// ---------------------------------------------------------------------------

/**
 * A human-approved grant for a peer (plan §9). The `scope` is the granted skill
 * names (default `[]` — authenticated but authorized for nothing). Returned by
 * {@link A2aAllowlist.lookup} ONLY when the peer is approved AND enabled.
 */
export interface PeerGrant {
  fingerprint: string;
  scope: string[];
  enabled: boolean;
}

/**
 * The allowlist gate (plan §3 P3 / §9). `lookup` returns the grant iff the peer
 * fingerprint is human-approved AND enabled for this personality; otherwise
 * `null` → default-deny. This is checked FIRST in the handshake, before any
 * nonce is issued or token minted.
 */
export interface A2aAllowlist {
  lookup(personalityId: string, peerFingerprint: string): Promise<PeerGrant | null>;
}

// ---------------------------------------------------------------------------
// Peer store — runtime peer entries
// ---------------------------------------------------------------------------

/**
 * A persisted peer entry (plan §9 allowlist-entry minimum): the verified card,
 * the granted `scope` (default `[]`), the last-minted token reference (`tokenRef`
 * = the token's `jti`, for revocation), and the `enabled` flag.
 */
export interface PeerEntry {
  fingerprint: string;
  card: AgentCard;
  scope: string[];
  tokenRef?: string;
  enabled: boolean;
}

/**
 * Persistence for peer entries (plan §9). Keyed by (personalityId,
 * fingerprint). The handshake writes a disabled entry on a verified challenge
 * request and flips it to enabled (with a fresh `tokenRef`) once possession is
 * proven.
 */
export interface A2aPeerStore {
  get(personalityId: string, fingerprint: string): Promise<PeerEntry | null>;
  upsert(personalityId: string, entry: PeerEntry): Promise<void>;
}

/**
 * Storage-backed peer store — one JSON file per peer at
 * `<baseDir>/<personalityId>/peers/<fingerprint>.json`, written atomically
 * (mirrors how other extensions persist small JSON via the injected
 * {@link Storage}). This is the wiring/testing default; the real
 * per-personality-config source arrives in a later phase.
 */
export class StorageA2aPeerStore implements A2aPeerStore {
  constructor(
    private readonly storage: Storage,
    /** Absolute base directory (paths are absolute per the Storage contract). */
    private readonly baseDir: string,
  ) {}

  private path(personalityId: string, fingerprint: string): string {
    return `${this.baseDir}/${personalityId}/peers/${fingerprint}.json`;
  }

  async get(personalityId: string, fingerprint: string): Promise<PeerEntry | null> {
    const raw = await this.storage.read(this.path(personalityId, fingerprint));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPeerEntry(parsed)) return null;
    return parsed;
  }

  async upsert(personalityId: string, entry: PeerEntry): Promise<void> {
    const path = this.path(personalityId, entry.fingerprint);
    await this.storage.mkdir(`${this.baseDir}/${personalityId}/peers`);
    await this.storage.writeAtomic(path, JSON.stringify(entry), { mode: 0o600 });
  }
}

function isPeerEntry(value: unknown): value is PeerEntry {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.fingerprint === 'string' &&
    typeof v.enabled === 'boolean' &&
    Array.isArray(v.scope) &&
    v.card !== null &&
    typeof v.card === 'object'
  );
}

/**
 * Storage-backed allowlist — one JSON file per approved peer at
 * `<baseDir>/<personalityId>/allowlist/<fingerprint>.json` holding
 * `{ scope, enabled }`. A missing file (unknown peer) or `enabled: false`
 * yields `null` → default-deny. Wiring/testing default only.
 */
export class StorageA2aAllowlist implements A2aAllowlist {
  constructor(
    private readonly storage: Storage,
    private readonly baseDir: string,
  ) {}

  async lookup(personalityId: string, peerFingerprint: string): Promise<PeerGrant | null> {
    const path = `${this.baseDir}/${personalityId}/allowlist/${peerFingerprint}.json`;
    const raw = await this.storage.read(path);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const v = parsed as Record<string, unknown>;
    const enabled = v.enabled === true;
    if (!enabled) return null;
    const scope = Array.isArray(v.scope)
      ? v.scope.filter((s): s is string => typeof s === 'string')
      : [];
    return { fingerprint: peerFingerprint, scope, enabled: true };
  }
}
