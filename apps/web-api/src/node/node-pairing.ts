/**
 * Pairing for laptop tool nodes (plan laptop-tool-node D4, T7, verification B4).
 *
 * The laptop opens `/node/pair` unauthenticated and asks; an operator approves a short code through
 * the cookie-only admin route; the server mints a `node:host` API key and sends it ONCE over the
 * pending socket. Abuse controls: at most `maxPending` pending requests, a 10-minute code TTL and a
 * per-IP token bucket (`createTokenBuckets`, ../middleware/rate-limit.ts). All pinned by
 * ./__tests__/node-socket.test.ts.
 */
import { randomInt } from 'node:crypto';
import {
  type ApproveResult,
  NODE_CLOSE,
  NODE_HOST_SCOPE,
  NODE_NAME_RE,
  type PairClientFrame,
  type PairServerFrame,
  type PendingPairing,
} from '@ethosagent/wiring/nodes';
import type { ApiKeyAdminStore } from '../middleware/bearer-auth';
import { createTokenBuckets } from '../middleware/rate-limit';

export interface PairConnection {
  send(frame: PairServerFrame): void;
  close(code: number, reason: string): void;
  /** False once the socket is closing or closed; a send then would vanish silently. */
  isOpen(): boolean;
  onFrame(cb: (f: PairClientFrame) => void): void;
  onClose(cb: () => void): void;
}
export interface NodePairingOptions {
  apiKeys: ApiKeyAdminStore;
  /** Default 5. */
  maxPending?: number;
  /** Default 600_000. */
  ttlMs?: number;
  now?: () => number;
  /** Default 5 per 60_000. */
  bucket?: { maxTokens: number; refillMs: number };
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

interface Entry {
  info: PendingPairing;
  conn: PairConnection;
}

export class NodePairing {
  private readonly pending = new Map<string, Entry>();
  private readonly buckets: ReturnType<typeof createTokenBuckets>;
  private readonly maxPending: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: NodePairingOptions) {
    this.maxPending = opts.maxPending ?? 5;
    this.ttlMs = opts.ttlMs ?? 600_000;
    this.now = opts.now ?? Date.now;
    // lockoutMs 0: an empty bucket just refuses until the next refill.
    this.buckets = createTokenBuckets({
      maxTokens: opts.bucket?.maxTokens ?? 5,
      refillMs: opts.bucket?.refillMs ?? 60_000,
      lockoutMs: 0,
    });
  }

  /** pending < max AND the IP's token bucket has a token (a take consumes it). */
  canAccept(ip: string): boolean {
    this.pruneExpired();
    if (this.pending.size >= this.maxPending) return false;
    return this.buckets.take(ip, this.now()).ok;
  }

  open(conn: PairConnection): void {
    let mine: string | undefined;
    conn.onFrame((frame) => {
      if (mine !== undefined) {
        conn.send({ v: 1, kind: 'pair_refused', reason: 'already_pending' });
        return;
      }
      if (!NODE_NAME_RE.test(frame.name)) {
        conn.send({ v: 1, kind: 'pair_refused', reason: 'bad_name' });
        conn.close(NODE_CLOSE.badFrame, 'bad node name');
        return;
      }
      const code = this.newCode();
      mine = code;
      const expiresAt = this.now() + this.ttlMs;
      this.pending.set(code, {
        info: { code, name: frame.name, roots: frame.roots, expiresAt },
        conn,
      });
      conn.send({ v: 1, kind: 'pair_pending', code, expiresAt });
    });
    conn.onClose(() => {
      if (mine !== undefined && this.pending.get(mine)?.conn === conn) this.pending.delete(mine);
    });
  }

  /** Case-insensitive. Mints, sends once over the pending socket, forgets the code. */
  async approve(code: string): Promise<ApproveResult> {
    const key = code.trim().toUpperCase();
    const entry = this.pending.get(key);
    if (!entry) return { ok: false, reason: 'unknown_code' };
    // Forget first: a concurrent second approve must find nothing (delivered once).
    this.pending.delete(key);
    if (this.now() >= entry.info.expiresAt) {
      this.refuse(entry, 'expired');
      return { ok: false, reason: 'expired' };
    }
    const name = entry.info.name;
    try {
      const keyName = `node:${name}`;
      // Re-pairing replaces, but only after the new key reached the laptop: the older keys of this
      // name are revoked once delivery succeeded, so a failed delivery leaves the working key valid
      // (pinned by node-socket.test.ts "failed delivery keeps the old key").
      const older = (await this.opts.apiKeys.list()).filter(
        (k) => k.name === keyName && !k.revokedAt,
      );
      const { secret, record } = await this.opts.apiKeys.create({
        name: keyName,
        scopes: [NODE_HOST_SCOPE],
      });
      // The key is delivered once, over this socket. If the laptop hung up while the operator
      // approved, nobody holds the secret: revoke it rather than leave a live orphan key
      // (pinned by node-socket.test.ts "revokes the minted key").
      let delivered = false;
      if (entry.conn.isOpen()) {
        try {
          entry.conn.send({ v: 1, kind: 'pair_approved', key: secret, keyId: record.id });
          delivered = true;
        } catch {
          // Falls through to the revoke below.
        }
      }
      if (!delivered) {
        await this.opts.apiKeys.revoke(record.prefix);
        return { ok: false, reason: 'connection_closed' };
      }
      for (const k of older) await this.opts.apiKeys.revoke(k.prefix);
      entry.conn.close(NODE_CLOSE.normal, 'paired');
      return { ok: true, name, keyId: record.id };
    } catch (err) {
      this.refuse(entry, 'server_error');
      throw err;
    }
  }

  listPending(): PendingPairing[] {
    this.pruneExpired();
    return [...this.pending.values()].map((e) => e.info);
  }

  close(): void {
    for (const e of this.pending.values()) e.conn.close(NODE_CLOSE.normal, 'server closing');
    this.pending.clear();
  }

  private refuse(entry: Entry, reason: string): void {
    entry.conn.send({ v: 1, kind: 'pair_refused', reason });
    entry.conn.close(NODE_CLOSE.normal, reason);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [code, e] of [...this.pending]) {
      if (now >= e.info.expiresAt) {
        this.pending.delete(code);
        this.refuse(e, 'expired');
      }
    }
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.pending.has(code)) return code;
    }
  }
}
