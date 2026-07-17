// FunnelTracker — W4.1 time-to-first-message instrumentation.
//
// Owns the `funnel-state.json` stamp file under the ethos data dir so the
// three funnel events (`funnel.setup_completed`, `funnel.first_reply`,
// `funnel.channel_first_reply`) each emit EXACTLY ONCE per install, without
// scanning sessions.db per turn. All writes go through `Storage.writeAtomic`
// (a torn stamp file would double-emit forever).
//
// Rules encoded here:
//   • emits-exactly-once — a stamped event never re-emits.
//   • earliest-event-wins — on a cross-process double-write, the merge keeps
//     the earlier timestamp for every stamp.
//   • legacy-install guard — a first reply on an install with NO
//     setup_completed stamp (pre-funnel 0.5.x installs) marks the install
//     `legacy`; the event carries `legacy: true` and no `msSinceSetup`, so
//     TTFM statistics can exclude it.
//
// Cross-process write safety (not exactly-once — that needs an advisory lock):
// three writers (CLI, gateway, web-api) can interleave. `writeAtomic` alone
// prevents a torn file but NOT a lost update. So `commit()` RE-READS disk
// immediately before writing, merges (earliest-wins + presence-OR),
// RECOMPUTES `legacy` from the MERGED disk state — never the stale pre-load
// snapshot — and reads back to converge if a sibling wrote in the window.
// The net guarantee is at-most-once-per-process with earliest-wins and no
// false-legacy: a concurrent setup stamp is never clobbered and a completed
// install is never mis-marked legacy. This is the right bar for fail-open
// telemetry; true exactly-once across processes would require a lock.
//
// Emission is wiring/app-layer only: apps construct one tracker and call the
// record methods from their turn-completion seams. The tracker is fail-open —
// a storage or observability error must never break a turn.

import { dirname, join } from 'node:path';
import type { Storage } from '@ethosagent/types';

export const FUNNEL_STATE_FILE = 'funnel-state.json';

export type FunnelWizardPath = 'tui' | 'web' | 'readline' | 'env';

export interface FunnelState {
  /** Epoch ms when setup completed (wizard finished writing config). */
  setupCompletedAt?: number;
  setupProvider?: string;
  setupChannels?: string[];
  setupWizardPath?: FunnelWizardPath;
  /** Epoch ms of the first-ever completed turn on any surface. */
  firstReplyAt?: number;
  /** Epoch ms of the first completed turn per channel platform. */
  channelFirstReplyAt?: Record<string, number>;
  /** True when a reply was recorded on an install that predates funnel tracking. */
  legacy?: boolean;
}

/** The three typed helpers the tracker needs — a structural slice of EthosObservability. */
export interface FunnelObservability {
  recordFunnelSetupCompleted(opts: {
    provider: string;
    channels: string[];
    wizardPath: FunnelWizardPath;
  }): void;
  recordFunnelFirstReply(opts: { msSinceSetup?: number; legacy?: boolean }): void;
  recordFunnelChannelFirstReply(opts: {
    platform: string;
    msSinceSetup?: number;
    legacy?: boolean;
  }): void;
  /** Fail-open error sink — a funnel persistence failure (read-only mount,
   *  full disk) routes here instead of vanishing silently. */
  recordError(opts: { code?: string; cause?: string }): void;
}

/** Bounded read-back re-merge attempts after a write, to converge with a
 *  sibling process that wrote in the same window. Earliest-wins is idempotent
 *  so a few attempts suffice; the cap stops a pathological writer spinning us. */
const COMMIT_MAX_RETRIES = 3;

export interface FunnelTrackerOptions {
  storage: Storage;
  /** Ethos data dir (`~/.ethos`) — the stamp file lives at its root. */
  dataDir: string;
  observability: FunnelObservability;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Merge two states keeping the EARLIEST timestamp for every stamp. */
export function mergeFunnelState(a: FunnelState, b: FunnelState): FunnelState {
  const earlier = (x?: number, y?: number): number | undefined => {
    if (x === undefined) return y;
    if (y === undefined) return x;
    return Math.min(x, y);
  };
  const setupCompletedAt = earlier(a.setupCompletedAt, b.setupCompletedAt);
  // Setup metadata follows whichever side owns the earlier stamp.
  const setupMeta =
    a.setupCompletedAt !== undefined && a.setupCompletedAt === setupCompletedAt ? a : b;
  const channels: Record<string, number> = { ...(a.channelFirstReplyAt ?? {}) };
  for (const [platform, ts] of Object.entries(b.channelFirstReplyAt ?? {})) {
    const existing = channels[platform];
    channels[platform] = existing === undefined ? ts : Math.min(existing, ts);
  }
  return {
    ...(setupCompletedAt !== undefined ? { setupCompletedAt } : {}),
    ...(setupMeta.setupProvider !== undefined ? { setupProvider: setupMeta.setupProvider } : {}),
    ...(setupMeta.setupChannels !== undefined ? { setupChannels: setupMeta.setupChannels } : {}),
    ...(setupMeta.setupWizardPath !== undefined
      ? { setupWizardPath: setupMeta.setupWizardPath }
      : {}),
    ...(earlier(a.firstReplyAt, b.firstReplyAt) !== undefined
      ? { firstReplyAt: earlier(a.firstReplyAt, b.firstReplyAt) }
      : {}),
    ...(Object.keys(channels).length > 0 ? { channelFirstReplyAt: channels } : {}),
    ...(a.legacy || b.legacy ? { legacy: true } : {}),
  };
}

export class FunnelTracker {
  private readonly storage: Storage;
  private readonly path: string;
  private readonly observability: FunnelObservability;
  private readonly now: () => number;
  /** Serialize record operations within this process. */
  private queue: Promise<void> = Promise.resolve();
  /** Once a stamp is confirmed on disk it never un-stamps — cheap no-op gate. */
  private cached: FunnelState | null = null;

  constructor(opts: FunnelTrackerOptions) {
    this.storage = opts.storage;
    this.path = join(opts.dataDir, FUNNEL_STATE_FILE);
    this.observability = opts.observability;
    this.now = opts.now ?? Date.now;
  }

  /** Read the current stamp state (for `ethos doctor --funnel`). Null when absent. */
  async readState(): Promise<FunnelState | null> {
    const raw = await this.storage.read(this.path);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as FunnelState;
    } catch {
      return null;
    }
  }

  async recordSetupCompleted(opts: {
    provider: string;
    channels: string[];
    wizardPath: FunnelWizardPath;
  }): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.load();
      if (state.setupCompletedAt !== undefined) return; // earliest wins (fast no-op gate)
      const { before } = await this.commit({
        setupCompletedAt: this.now(),
        setupProvider: opts.provider,
        setupChannels: opts.channels,
        setupWizardPath: opts.wizardPath,
      });
      // Only the process that transitioned setup absent→present emits — a
      // sibling that stamped it first (seen on the pre-write re-read) does not.
      if (before.setupCompletedAt === undefined) {
        this.observability.recordFunnelSetupCompleted(opts);
      }
    });
  }

  async recordFirstReply(): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.load();
      if (state.firstReplyAt !== undefined) return; // emits exactly once (fast no-op gate)
      const { merged, before } = await this.commit({ firstReplyAt: this.now() });
      if (before.firstReplyAt !== undefined) return; // a sibling already stamped it
      // legacy is recomputed from the MERGED disk state, so a setup stamp that
      // landed concurrently keeps this reply out of the legacy bucket.
      const setupAt = merged.setupCompletedAt;
      this.observability.recordFunnelFirstReply(
        setupAt === undefined
          ? { legacy: true }
          : { msSinceSetup: (merged.firstReplyAt as number) - setupAt },
      );
    });
  }

  async recordChannelFirstReply(platform: string): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.load();
      if (state.channelFirstReplyAt?.[platform] !== undefined) return; // once per platform
      const { merged, before } = await this.commit({
        channelFirstReplyAt: { [platform]: this.now() },
      });
      if (before.channelFirstReplyAt?.[platform] !== undefined) return; // sibling stamped it
      const setupAt = merged.setupCompletedAt;
      const ts = merged.channelFirstReplyAt?.[platform] as number;
      this.observability.recordFunnelChannelFirstReply(
        setupAt === undefined
          ? { platform, legacy: true }
          : { platform, msSinceSetup: ts - setupAt },
      );
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Chain onto the queue; route errors to the observability sink so a
   *  read-only mount / full disk surfaces, but never reject (funnel telemetry
   *  must not break a turn). */
  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.queue.then(op).catch((err: unknown) => {
      try {
        this.observability.recordError({
          code: 'funnel.persist_failed',
          cause: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // Even the error sink is best-effort — swallow so the turn continues.
      }
    });
    this.queue = next;
    return next;
  }

  /**
   * Load state, always re-reading disk while stamps are still missing so a
   * concurrent process's stamp is seen (earliest-event-wins across
   * processes). Once every stamp this process cares about exists, the cached
   * copy short-circuits further I/O.
   */
  private async load(): Promise<FunnelState> {
    const disk = await this.readState();
    this.cached = disk === null ? (this.cached ?? {}) : mergeFunnelState(this.cached ?? {}, disk);
    return this.cached;
  }

  /**
   * Merge `patch` into the CURRENT disk state and persist. Re-reads disk right
   * before writing so a sibling process's stamp is never clobbered, recomputes
   * `legacy` from the merged disk state, and reads back to converge if a
   * sibling wrote in the window. Returns the merged state plus the disk state
   * as it was BEFORE this process wrote, so callers decide emission from
   * presence (absent→present flip) rather than a stale pre-load snapshot.
   */
  private async commit(patch: FunnelState): Promise<{ merged: FunnelState; before: FunnelState }> {
    await this.storage.mkdir(dirname(this.path));
    const before = (await this.readState()) ?? {};
    let merged = this.mergeAndRecomputeLegacy(before, patch);
    await this.storage.writeAtomic(this.path, JSON.stringify(merged, null, 2));
    for (let attempt = 0; attempt < COMMIT_MAX_RETRIES; attempt++) {
      const after = (await this.readState()) ?? {};
      if (this.survives(after, merged)) break;
      merged = this.mergeAndRecomputeLegacy(after, merged);
      await this.storage.writeAtomic(this.path, JSON.stringify(merged, null, 2));
    }
    this.cached = merged;
    return { merged, before };
  }

  /** Merge, then set `legacy` iff a reply is present with NO setup stamp on the
   *  merged disk state. Setup present ⇒ never legacy (strips a stale flag). */
  private mergeAndRecomputeLegacy(disk: FunnelState, patch: FunnelState): FunnelState {
    const merged = mergeFunnelState(disk, patch);
    const hasReply =
      merged.firstReplyAt !== undefined || Object.keys(merged.channelFirstReplyAt ?? {}).length > 0;
    if (merged.setupCompletedAt !== undefined) {
      delete merged.legacy;
    } else if (hasReply) {
      merged.legacy = true;
    }
    return merged;
  }

  /** True when every stamp `merged` carries still exists on `after` — i.e. a
   *  sibling write didn't drop any of our contribution. Presence-only: earlier
   *  values from the sibling are fine (earliest-wins). */
  private survives(after: FunnelState, merged: FunnelState): boolean {
    if (merged.setupCompletedAt !== undefined && after.setupCompletedAt === undefined) return false;
    if (merged.firstReplyAt !== undefined && after.firstReplyAt === undefined) return false;
    for (const platform of Object.keys(merged.channelFirstReplyAt ?? {})) {
      if (after.channelFirstReplyAt?.[platform] === undefined) return false;
    }
    return true;
  }
}
