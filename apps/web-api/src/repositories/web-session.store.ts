import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { requireStorage } from './require-storage';

// Server-side web sessions (web-auth-bootstrap D4). A human login mints a
// random 32-byte hex id; the cookie carries the id, and the shared verifier
// (`createCookieVerifier`) accepts it alongside the raw bootstrap token.
//
// Persisted through Storage to `<dataDir>/web-sessions.json` (writeAtomic,
// mode 0600) so a server restart does not log everyone out. Ids are 256-bit
// random, so an exact-key lookup is safe — no constant-time comparison is
// needed to find one.

const SESSION_ID_BYTES = 32;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matching the cookie maxAge

interface PersistedSessions {
  sessions: Record<string, { createdAt: string }>;
}

export interface WebSessionStoreOptions {
  /** Where `~/.ethos` lives. The file is `<dataDir>/web-sessions.json`. */
  dataDir: string;
  /** Storage backend. Injected by the composition root; required. */
  storage: Storage;
  /** Session lifetime. Defaults to 30 days (the cookie maxAge). */
  ttlMs?: number;
}

export class WebSessionStore {
  private readonly storage: Storage;
  private readonly path: string;
  private readonly dir: string;
  private readonly ttlMs: number;
  /** In-memory view, lazily hydrated from disk. id → createdAt epoch ms. */
  private cache: Map<string, number> | null = null;

  constructor(opts: WebSessionStoreOptions) {
    this.storage = requireStorage(opts.storage, 'WebSessionStore');
    this.dir = opts.dataDir;
    this.path = join(opts.dataDir, 'web-sessions.json');
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Mint a fresh session id, persist it, and return it. */
  async create(): Promise<string> {
    const sessions = await this.load();
    const id = randomBytes(SESSION_ID_BYTES).toString('hex');
    sessions.set(id, Date.now());
    this.prune(sessions);
    await this.persist(sessions);
    return id;
  }

  /** True when `id` names a live (unexpired) session. */
  async has(id: string): Promise<boolean> {
    if (!id) return false;
    const sessions = await this.load();
    const createdAt = sessions.get(id);
    if (createdAt === undefined) return false;
    if (Date.now() - createdAt >= this.ttlMs) {
      // Expired — treated as absent; the row is dropped on the next write.
      sessions.delete(id);
      return false;
    }
    return true;
  }

  /** Drop every session (D6: reset logs every browser out). */
  async invalidateAll(): Promise<void> {
    this.cache = new Map();
    await this.persist(this.cache);
  }

  private async load(): Promise<Map<string, number>> {
    if (this.cache) return this.cache;
    const map = new Map<string, number>();
    const raw = await this.storage.read(this.path);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Partial<PersistedSessions>;
        for (const [id, row] of Object.entries(parsed.sessions ?? {})) {
          const at = Date.parse(row?.createdAt ?? '');
          if (Number.isFinite(at)) map.set(id, at);
        }
      } catch {
        // Unreadable file — start empty; the next write replaces it.
      }
    }
    this.prune(map);
    this.cache = map;
    return map;
  }

  private prune(sessions: Map<string, number>): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, createdAt] of sessions) {
      if (createdAt < cutoff) sessions.delete(id);
    }
  }

  private async persist(sessions: Map<string, number>): Promise<void> {
    await this.storage.mkdir(this.dir);
    const out: PersistedSessions = { sessions: {} };
    for (const [id, createdAt] of sessions) {
      out.sessions[id] = { createdAt: new Date(createdAt).toISOString() };
    }
    await this.storage.writeAtomic(this.path, `${JSON.stringify(out, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
