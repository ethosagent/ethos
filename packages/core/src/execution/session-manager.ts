/**
 * SessionManager — a lifecycle decorator over an ExecutionBackend that keeps
 * persistent exec sessions alive across turns, keyed by (personality.id,
 * sessionId).
 *
 * We prefer drain-then-dispose to preserve rw-mount write integrity — a
 * hard-kill mid-write could leave a partially-written file on the rw bind
 * mount. Idle and cap eviction SKIP in-flight entries rather than
 * hard-killing. Only a config-change recreate forces the issue, and it STILL
 * drains: it waits for inFlight to reach 0 before disposing.
 */
import { createHash } from 'node:crypto';
import type {
  ExecChunk,
  ExecOpts,
  ExecSession,
  ExecutionBackend,
  PersonalityConfig,
} from '@ethosagent/types';

export interface SessionLifecycleEvent {
  type: 'spawned' | 'recreated' | 'evicted';
  personalityId: string;
  sessionId: string;
  reason?: 'idle' | 'cap' | 'config-change';
}

export interface SessionManagerOptions {
  idleTtlMs?: number; // default 5 * 60_000
  maxSessions?: number; // default 8
  recreateDebounceMs?: number; // default 250 — coalescing window (documented)
  onEvent?: (e: SessionLifecycleEvent) => void;
  now?: () => number; // default () => Date.now() — injectable clock for tests
}

interface Entry {
  session: ExecSession;
  hash: string;
  lastUsed: number;
  inFlight: number;
  disposed: boolean;
  recreating?: Promise<void>;
}

// Deterministic JSON: sort object keys so structurally-equal configs hash
// equal regardless of insertion order. The `v as Record<string, unknown>` is a
// structural narrow of an already-object-typed local (we've checked it's a
// non-null, non-array object), not an API/return cast.
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export class SessionManager implements ExecutionBackend {
  private readonly idleTtlMs: number;
  private readonly maxSessions: number;
  // Stored but not used as a timer: the per-key `recreating` promise makes the
  // practical coalescing window "until the in-flight recreate settles". This
  // field documents the intended debounce window for future tuning.
  private readonly recreateDebounceMs: number;
  private readonly onEvent?: (e: SessionLifecycleEvent) => void;
  private readonly now: () => number;
  private entries = new Map<string, Entry>();

  constructor(
    private inner: ExecutionBackend,
    opts: SessionManagerOptions = {},
  ) {
    this.idleTtlMs = opts.idleTtlMs ?? 5 * 60_000;
    this.maxSessions = opts.maxSessions ?? 8;
    this.recreateDebounceMs = opts.recreateDebounceMs ?? 250;
    this.onEvent = opts.onEvent;
    this.now = opts.now ?? (() => Date.now());
  }

  get name(): string {
    return this.inner.name;
  }

  isAvailable() {
    return this.inner.isAvailable();
  }

  mountsFor(p: PersonalityConfig) {
    return this.inner.mountsFor(p);
  }

  spawnSession(personalityId: string) {
    return this.inner.spawnSession(personalityId);
  }

  private keyFor(personalityId: string, sessionId: string): string {
    return `${personalityId}\0${sessionId}`;
  }

  private emit(e: SessionLifecycleEvent): void {
    this.onEvent?.(e);
  }

  private computeConfigHash(p: PersonalityConfig): string {
    const canonical = {
      mounts: this.inner
        .mountsFor(p)
        .map((m) => ({ hostPath: m.hostPath, containerPath: m.containerPath, mode: m.mode }))
        .sort((a, b) => (a.hostPath + a.mode).localeCompare(b.hostPath + b.mode)),
      toolset: [...(p.toolset ?? [])].sort(),
      // `execution` is NOT on the frozen PersonalityConfig type — defensive read.
      // This is the ONE permitted `as` cast in production code.
      execution: (p as { execution?: string }).execution ?? null,
      network: p.safety?.network
        ? {
            allow: [...(p.safety.network.allow ?? [])].sort(),
            deny: [...(p.safety.network.deny ?? [])].sort(),
            allow_private_urls: p.safety.network.allow_private_urls ?? false,
          }
        : null,
    };
    return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
  }

  async *exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
    if (!opts.personality) {
      yield* this.inner.exec(cmd, opts);
      return;
    }
    const p = opts.personality;
    const personalityId = p.id;
    const sessionId = opts.sessionId ?? '';
    const key = this.keyFor(personalityId, sessionId);
    const hash = this.computeConfigHash(p);
    const now = this.now();

    // Idle sweep: dispose lanes (other than this one) that are idle past the
    // TTL and have no in-flight execs. In-flight lanes are skipped.
    for (const [k, entry] of [...this.entries.entries()]) {
      if (k !== key && entry.inFlight === 0 && now - entry.lastUsed > this.idleTtlMs) {
        await entry.session.dispose();
        entry.disposed = true;
        this.entries.delete(k);
        const [pid, ...rest] = k.split('\0');
        const sid = rest.join('\0');
        this.emit({
          type: 'evicted',
          personalityId: pid ?? '',
          sessionId: sid,
          reason: 'idle',
        });
      }
    }

    let entry = this.entries.get(key);

    // Config-change recreate. When the personality's config hash changes,
    // recreate the session. The recreate happens immediately on the first exec
    // observing a changed hash, guarded by the per-key `recreating` promise so
    // N near-simultaneous execs with the SAME new hash trigger exactly ONE
    // dispose+spawn. `recreateDebounceMs` is the documented coalescing window;
    // the lock makes the practical window "until the in-flight recreate
    // settles". It drains first: it waits for inFlight to reach 0 before
    // disposing the old session.
    if (entry && entry.hash !== hash) {
      if (entry.recreating) {
        await entry.recreating;
        entry = this.entries.get(key);
      } else {
        const current = entry;
        const recreate = (async () => {
          // drain-then-dispose: wait for in-flight execs on the OLD session to finish
          while (current.inFlight > 0) {
            await new Promise((r) => setTimeout(r, 0));
          }
          await current.session.dispose();
          current.disposed = true;
          this.entries.delete(key);
          const session = this.inner.spawnSession(personalityId);
          const fresh: Entry = {
            session,
            hash,
            lastUsed: this.now(),
            inFlight: 0,
            disposed: false,
          };
          this.entries.set(key, fresh);
          this.emit({ type: 'recreated', personalityId, sessionId, reason: 'config-change' });
        })();
        current.recreating = recreate;
        await recreate;
        entry = this.entries.get(key);
      }
    }

    // Lazy spawn: only create a session when an exec actually arrives.
    if (!entry) {
      const session = this.inner.spawnSession(personalityId);
      entry = { session, hash, lastUsed: now, inFlight: 0, disposed: false };
      this.entries.set(key, entry);
      this.emit({ type: 'spawned', personalityId, sessionId });

      // Cap enforcement: evict LRU idle lanes until under the cap. Never evict
      // the entry just created; in-flight lanes are skipped (allow temporary
      // over-cap when everything else is busy).
      while (this.entries.size > this.maxSessions) {
        let lruKey: string | undefined;
        let lruEntry: Entry | undefined;
        for (const [k, e] of this.entries) {
          if (k === key || e.inFlight > 0) continue;
          if (!lruEntry || e.lastUsed < lruEntry.lastUsed) {
            lruKey = k;
            lruEntry = e;
          }
        }
        if (!lruKey || !lruEntry) break; // all others in-flight — allow temporary over-cap
        await lruEntry.session.dispose();
        lruEntry.disposed = true;
        this.entries.delete(lruKey);
        const [pid, ...rest] = lruKey.split('\0');
        this.emit({
          type: 'evicted',
          personalityId: pid ?? '',
          sessionId: rest.join('\0'),
          reason: 'cap',
        });
      }
    }

    if (!entry) return;
    entry.lastUsed = now;

    entry.inFlight++;
    try {
      yield* entry.session.exec(cmd, opts);
    } finally {
      entry.inFlight--;
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map((e) => e.session.dispose()));
    this.entries.clear();
    await this.inner.dispose();
  }
}
