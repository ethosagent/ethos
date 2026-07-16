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
}

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
      if (state.setupCompletedAt !== undefined) return; // earliest wins
      const next = mergeFunnelState(state, {
        setupCompletedAt: this.now(),
        setupProvider: opts.provider,
        setupChannels: opts.channels,
        setupWizardPath: opts.wizardPath,
      });
      await this.persist(next);
      this.observability.recordFunnelSetupCompleted(opts);
    });
  }

  async recordFirstReply(): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.load();
      if (state.firstReplyAt !== undefined) return; // emits exactly once
      const now = this.now();
      const legacy = state.setupCompletedAt === undefined;
      const next = mergeFunnelState(state, {
        firstReplyAt: now,
        ...(legacy ? { legacy: true } : {}),
      });
      await this.persist(next);
      this.observability.recordFunnelFirstReply(
        legacy ? { legacy: true } : { msSinceSetup: now - (state.setupCompletedAt as number) },
      );
    });
  }

  async recordChannelFirstReply(platform: string): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.load();
      if (state.channelFirstReplyAt?.[platform] !== undefined) return; // once per platform
      const now = this.now();
      const legacy = state.setupCompletedAt === undefined;
      const next = mergeFunnelState(state, {
        channelFirstReplyAt: { [platform]: now },
        ...(legacy ? { legacy: true } : {}),
      });
      await this.persist(next);
      this.observability.recordFunnelChannelFirstReply(
        legacy
          ? { platform, legacy: true }
          : { platform, msSinceSetup: now - (state.setupCompletedAt as number) },
      );
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Chain onto the queue; swallow errors so funnel never breaks a turn. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.queue.then(op).catch(() => {});
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

  private async persist(state: FunnelState): Promise<void> {
    await this.storage.mkdir(dirname(this.path));
    await this.storage.writeAtomic(this.path, JSON.stringify(state, null, 2));
    this.cached = state;
  }
}
