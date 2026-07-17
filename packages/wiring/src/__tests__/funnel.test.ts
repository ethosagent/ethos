import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  FUNNEL_STATE_FILE,
  type FunnelObservability,
  type FunnelState,
  FunnelTracker,
  mergeFunnelState,
} from '../observability/funnel';

const DATA_DIR = '/data/.ethos';

function makeSpyObservability() {
  const calls: Array<{ method: string; opts: Record<string, unknown> }> = [];
  const observability: FunnelObservability = {
    recordFunnelSetupCompleted(opts) {
      calls.push({ method: 'setup_completed', opts });
    },
    recordFunnelFirstReply(opts) {
      calls.push({ method: 'first_reply', opts });
    },
    recordFunnelChannelFirstReply(opts) {
      calls.push({ method: 'channel_first_reply', opts });
    },
    recordError(opts) {
      calls.push({ method: 'error', opts });
    },
  };
  return { observability, calls };
}

function makeTracker(opts: { now?: () => number; storage?: InMemoryStorage } = {}) {
  const storage = opts.storage ?? new InMemoryStorage();
  const { observability, calls } = makeSpyObservability();
  const tracker = new FunnelTracker({
    storage,
    dataDir: DATA_DIR,
    observability,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { tracker, storage, calls };
}

async function readStamp(storage: InMemoryStorage): Promise<FunnelState> {
  const raw = await storage.read(join(DATA_DIR, FUNNEL_STATE_FILE));
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string) as FunnelState;
}

describe('FunnelTracker', () => {
  it('setup_completed stamps the state file and emits once', async () => {
    const { tracker, storage, calls } = makeTracker({ now: () => 1_000 });

    await tracker.recordSetupCompleted({
      provider: 'anthropic',
      channels: ['telegram'],
      wizardPath: 'tui',
    });
    // Second run of setup on the same install — earliest wins, no re-emit.
    await tracker.recordSetupCompleted({
      provider: 'openrouter',
      channels: [],
      wizardPath: 'readline',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'setup_completed',
      opts: { provider: 'anthropic', channels: ['telegram'], wizardPath: 'tui' },
    });
    const stamp = await readStamp(storage);
    expect(stamp).toMatchObject({
      setupCompletedAt: 1_000,
      setupProvider: 'anthropic',
      setupChannels: ['telegram'],
      setupWizardPath: 'tui',
    });
  });

  it('first_reply emits exactly once with msSinceSetup', async () => {
    let now = 5_000;
    const { tracker, calls } = makeTracker({ now: () => now });

    await tracker.recordSetupCompleted({ provider: 'anthropic', channels: [], wizardPath: 'tui' });
    now = 65_000;
    await tracker.recordFirstReply();
    now = 99_000;
    await tracker.recordFirstReply(); // every later turn — must be a no-op

    const firstReplies = calls.filter((call) => call.method === 'first_reply');
    expect(firstReplies).toHaveLength(1);
    expect(firstReplies[0]?.opts).toEqual({ msSinceSetup: 60_000 });
  });

  it('channel_first_reply stamps once per platform with msSinceSetup', async () => {
    let now = 1_000;
    const { tracker, calls } = makeTracker({ now: () => now });

    await tracker.recordSetupCompleted({
      provider: 'anthropic',
      channels: ['telegram', 'slack'],
      wizardPath: 'tui',
    });
    now = 31_000;
    await tracker.recordChannelFirstReply('telegram');
    await tracker.recordChannelFirstReply('telegram'); // no re-emit
    now = 61_000;
    await tracker.recordChannelFirstReply('slack'); // distinct platform emits

    const channelReplies = calls.filter((call) => call.method === 'channel_first_reply');
    expect(channelReplies).toHaveLength(2);
    expect(channelReplies[0]?.opts).toEqual({ platform: 'telegram', msSinceSetup: 30_000 });
    expect(channelReplies[1]?.opts).toEqual({ platform: 'slack', msSinceSetup: 60_000 });
  });

  it('legacy-install guard: first_reply with no setup stamp marks legacy, no timing', async () => {
    const { tracker, storage, calls } = makeTracker({ now: () => 7_000 });

    await tracker.recordFirstReply();

    expect(calls).toEqual([{ method: 'first_reply', opts: { legacy: true } }]);
    const stamp = await readStamp(storage);
    expect(stamp.legacy).toBe(true);
    expect(stamp.firstReplyAt).toBe(7_000);
    expect(stamp.setupCompletedAt).toBeUndefined();
  });

  it('legacy-install guard applies to channel_first_reply too', async () => {
    const { tracker, calls } = makeTracker({ now: () => 7_000 });

    await tracker.recordChannelFirstReply('telegram');

    expect(calls).toEqual([
      { method: 'channel_first_reply', opts: { platform: 'telegram', legacy: true } },
    ]);
  });

  it('cross-process stamp on disk suppresses emission (emits-exactly-once across processes)', async () => {
    const storage = new InMemoryStorage();
    const first = makeTracker({ storage, now: () => 1_000 });
    await first.tracker.recordSetupCompleted({
      provider: 'anthropic',
      channels: [],
      wizardPath: 'tui',
    });
    await first.tracker.recordFirstReply();

    // A second process (e.g. the gateway) sharing the same data dir.
    const second = makeTracker({ storage, now: () => 2_000 });
    await second.tracker.recordFirstReply();

    expect(second.calls).toHaveLength(0);
  });

  it('is fail-open — a storage error never rejects but routes to recordError', async () => {
    const storage = new InMemoryStorage();
    const broken = {
      ...storage,
      read: () => Promise.reject(new Error('disk on fire')),
      writeAtomic: () => Promise.reject(new Error('disk on fire')),
      mkdir: () => Promise.reject(new Error('disk on fire')),
    } as unknown as InMemoryStorage;
    const { observability, calls } = makeSpyObservability();
    const tracker = new FunnelTracker({ storage: broken, dataDir: DATA_DIR, observability });

    await expect(tracker.recordFirstReply()).resolves.toBeUndefined();
    // The failure must SURFACE (a read-only mount / full disk can't be silent).
    expect(calls).toContainEqual({
      method: 'error',
      opts: { code: 'funnel.persist_failed', cause: 'disk on fire' },
    });
  });

  it('cross-process race: a concurrent setup stamp is not clobbered and never marks legacy', async () => {
    // Three trackers share one Storage, standing in for CLI + gateway + web-api
    // all racing on the same funnel-state.json.
    const storage = new InMemoryStorage();
    const setupTracker = makeTracker({ storage, now: () => 1_000 });
    const replyA = makeTracker({ storage, now: () => 2_000 });
    const replyB = makeTracker({ storage, now: () => 3_000 });

    // Setup completes while two other processes record a first reply, all
    // interleaved on the shared store.
    await Promise.all([
      setupTracker.tracker.recordSetupCompleted({
        provider: 'anthropic',
        channels: ['telegram'],
        wizardPath: 'env',
      }),
      replyA.tracker.recordFirstReply(),
      replyB.tracker.recordFirstReply(),
    ]);

    const stamp = await readStamp(storage);
    // The setup stamp survived the concurrent reply writes...
    expect(stamp.setupCompletedAt).toBe(1_000);
    // ...and because setup is present on disk, the install is NOT legacy.
    expect(stamp.legacy).toBeFalsy();
    expect(stamp.firstReplyAt).toBeDefined();

    // The setup event is emitted exactly once by the single process that owns it.
    const setupEmits = setupTracker.calls.filter((call) => call.method === 'setup_completed');
    expect(setupEmits).toHaveLength(1);
    // Neither reply-process double-counts its own first_reply event.
    expect(replyA.calls.filter((c) => c.method === 'first_reply').length).toBeLessThanOrEqual(1);
    expect(replyB.calls.filter((c) => c.method === 'first_reply').length).toBeLessThanOrEqual(1);
  });

  it('readState returns null when no stamp file exists', async () => {
    const { tracker } = makeTracker();
    expect(await tracker.readState()).toBeNull();
  });
});

describe('mergeFunnelState', () => {
  it('keeps the earliest timestamp for every stamp', () => {
    const merged = mergeFunnelState(
      {
        setupCompletedAt: 2_000,
        setupProvider: 'later',
        firstReplyAt: 5_000,
        channelFirstReplyAt: { telegram: 9_000 },
      },
      {
        setupCompletedAt: 1_000,
        setupProvider: 'earlier',
        firstReplyAt: 6_000,
        channelFirstReplyAt: { telegram: 8_000, slack: 4_000 },
      },
    );

    expect(merged.setupCompletedAt).toBe(1_000);
    expect(merged.setupProvider).toBe('earlier');
    expect(merged.firstReplyAt).toBe(5_000);
    expect(merged.channelFirstReplyAt).toEqual({ telegram: 8_000, slack: 4_000 });
  });

  it('legacy flag is sticky across merges', () => {
    expect(mergeFunnelState({ legacy: true }, { firstReplyAt: 1 }).legacy).toBe(true);
    expect(mergeFunnelState({ firstReplyAt: 1 }, { legacy: true }).legacy).toBe(true);
  });
});
