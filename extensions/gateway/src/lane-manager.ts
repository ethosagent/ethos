import { laneKeyBotKey } from '@ethosagent/core';
import { SessionLane } from '@ethosagent/session-lane';
import type { AttachmentCache, PlatformAdapter } from '@ethosagent/types';
import type { MessageDedupCache } from './dedup';
import type { GatewayBotConfig, GatewayObservability } from './gateway-config';
import type { LaneSessionEntry, LaneSessionFiles } from './lane-sessions';

/** What `LaneManager` reads and calls on `Gateway`: live getters (and setters for
 *  the fields it writes) over `Gateway`-owned state, closures for its methods. */
export interface LaneManagerDeps {
  readonly activeTurns: Map<
    string,
    { adapter: PlatformAdapter; chatId: string; threadId?: string; answered?: boolean }
  >;
  readonly attachmentCache: AttachmentCache | undefined;
  readonly bots: Map<string, GatewayBotConfig>;
  readonly incognitoLanes: Set<string>;
  readonly laneFiles: LaneSessionFiles | undefined;
  readonly laneMutes: Map<string, number>;
  readonly laneRestores: Map<string, Promise<void>>;
  readonly lanes: Map<string, SessionLane>;
  readonly lastInboundHadAudio: Map<string, boolean>;
  readonly maxChats: number;
  readonly observability: GatewayObservability | undefined;
  readonly outboundDedup: MessageDedupCache;
  readonly personalityIds: Map<string, string>;
  readonly sessionKeys: Map<string, string>;
  readonly usageStore: Map<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
}

export class LaneManager {
  constructor(private readonly deps: LaneManagerDeps) {}

  /**
   * The pending live-add lane restore for `botKey`, if any (see
   * `laneRestores`). Callers `await` it only when present, so the common path
   * — every boot-time bot — gains no microtask and no reordering.
   */
  pendingLaneRestore(botKey: string | undefined): Promise<void> | undefined {
    return botKey ? this.deps.laneRestores.get(botKey) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Session branches + the durable lane → session map (plan openclaw-9.5-adoption
  // item 5, D28)
  // ---------------------------------------------------------------------------

  /**
   * Load every configured bot's lane file (`LaneSessionFiles`) into
   * `sessionKeys` / `personalityIds`. Both adapter-owning hosts call it once,
   * right after `buildGateway` and BEFORE `adapter.start()` and
   * `replayInboundSpool()` (`startGatewayRuntime` in
   * apps/ethos/src/commands/gateway.ts, `runBoot` in apps/ethos/src/commands/boot.ts),
   * so a spool-replayed row, an interrupted `retry` and a `wake_review` turn
   * resolve the session the lane was on when the process died, not the lane's
   * default. A file that cannot be read or parsed is recorded as
   * `gateway.lane_sessions_unreadable` and that bot's lanes start on their
   * defaults. Pinned by extensions/gateway/src/__tests__/lane-sessions.test.ts.
   */
  async restoreLaneSessions(): Promise<void> {
    for (const botKey of this.deps.bots.keys()) await this.restoreBotLaneSessions(botKey);
  }

  /**
   * Load one bot's lane file into `sessionKeys` / `personalityIds`. A lane
   * this process already holds is left alone (it is newer than the file).
   * Never throws. Called for every configured bot by `restoreLaneSessions`,
   * and by `addBot` for a bot added live.
   */
  async restoreBotLaneSessions(botKey: string): Promise<void> {
    const files = this.deps.laneFiles;
    if (!files) return;
    let lanes: Map<string, LaneSessionEntry>;
    try {
      lanes = await files.load(botKey);
    } catch (err) {
      this.deps.observability?.recordSafetyBlock({
        code: 'gateway.lane_sessions_unreadable',
        cause: 'lane session file unreadable — this bot’s lanes start on their default sessions',
        details: {
          botKey,
          path: files.path(botKey),
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }
    for (const [laneKey, entry] of lanes) {
      // A row for another bot's lane is not this file's to restore.
      if (laneKeyBotKey(laneKey) !== botKey || this.deps.sessionKeys.has(laneKey)) continue;
      this.deps.sessionKeys.set(laneKey, entry.sessionKey);
      if (entry.personalityId) this.deps.personalityIds.set(laneKey, entry.personalityId);
      if (entry.mutedUntil !== undefined) this.deps.laneMutes.set(laneKey, entry.mutedUntil);
      if (entry.incognito) this.deps.incognitoLanes.add(laneKey);
    }
  }

  /** The lines `/new` and `/incognito` share: forget the old session's dedup
   *  keys and attachments, and move the lane onto a fresh session key. */
  rotateLaneSession(laneKey: string, previous: string): void {
    this.deps.outboundDedup.clearSession(previous);
    void this.deps.attachmentCache?.clear(previous).catch(() => {});
    this.deps.sessionKeys.set(laneKey, `${laneKey}:${Date.now()}`);
  }

  /**
   * Write the lane's bot's whole lane map. Awaited by every lane switch
   * BEFORE its ack, so a switch the user was told about survives a crash
   * that follows the ack. Fail-open: a write that throws is recorded
   * (`gateway.lane_sessions_write_failed`) and the switch still holds for
   * this process.
   */
  async persistLaneSessions(laneKey: string): Promise<void> {
    const files = this.deps.laneFiles;
    const botKey = laneKeyBotKey(laneKey);
    if (!files || !botKey) return;
    // Rewriting the whole file from a map the file has not been read into yet
    // would drop every lane it holds.
    const restoring = this.pendingLaneRestore(botKey);
    if (restoring) await restoring;
    const lanes: Record<string, LaneSessionEntry> = {};
    for (const [key, sessionKey] of this.deps.sessionKeys) {
      if (laneKeyBotKey(key) !== botKey) continue;
      const personalityId = this.deps.personalityIds.get(key);
      lanes[key] = { sessionKey, ...(personalityId ? { personalityId } : {}) };
    }
    // U11 — a lane's `/mute` rides beside its session key; a muted lane still
    // on its default session is written with that default (the lane key).
    const now = Date.now();
    for (const [key, mutedUntil] of this.deps.laneMutes) {
      if (laneKeyBotKey(key) !== botKey || mutedUntil <= now) continue;
      lanes[key] = { ...(lanes[key] ?? { sessionKey: key }), mutedUntil };
    }
    for (const key of this.deps.incognitoLanes) {
      if (laneKeyBotKey(key) !== botKey) continue;
      lanes[key] = { ...(lanes[key] ?? { sessionKey: key }), incognito: true };
    }
    try {
      await files.save(botKey, lanes);
    } catch (err) {
      this.deps.observability?.recordSafetyBlock({
        code: 'gateway.lane_sessions_write_failed',
        cause:
          'lane session map not persisted — after a restart this lane resumes its previous session',
        details: { botKey, laneKey, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  getOrCreateLane(key: string): SessionLane {
    const existing = this.deps.lanes.get(key);
    if (existing) {
      // LRU touch: re-insert to push to the tail so eviction skips it.
      this.deps.lanes.delete(key);
      this.deps.lanes.set(key, existing);
      return existing;
    }
    const lane = new SessionLane();
    this.deps.lanes.set(key, lane);
    this.evictIdleChats();
    return lane;
  }

  /**
   * Bound per-chat state at `maxChats`. Walks `lanes` in LRU order (oldest
   * first) and evicts the first idle chat — one whose lane queue is empty
   * and that has no in-flight turn. Active chats are skipped, so a flood of
   * new chats can't drop a user mid-response.
   */
  evictIdleChats(): void {
    while (this.deps.lanes.size > this.deps.maxChats) {
      let evictedKey: string | null = null;
      for (const [key, lane] of this.deps.lanes) {
        if (lane.length === 0 && !this.deps.activeTurns.has(key)) {
          evictedKey = key;
          break;
        }
      }
      if (evictedKey === null) return; // every chat is busy — leave the cap alone
      const evictedSession = this.deps.sessionKeys.get(evictedKey) ?? evictedKey;
      void this.deps.attachmentCache?.clear(evictedSession).catch(() => {});
      this.deps.lanes.delete(evictedKey);
      // `sessionKeys` / `personalityIds` are NOT evicted: they are the lane's
      // durable session choice (persisted per bot, D28), and dropping them here
      // would put the lane back on its default session in this process while
      // the lane file still names the branch — the next restart would disagree
      // with the running gateway. Both maps hold one short string per lane a
      // user explicitly moved.
      this.deps.usageStore.delete(evictedKey);
      // Voice mode is NOT evicted with the lane. Eviction is a memory-pressure
      // decision about in-process state; the mode is a persisted preference,
      // and dropping it here would silently un-set what the user typed the
      // moment a busy deployment crossed `maxChats`.
      this.deps.lastInboundHadAudio.delete(evictedKey);
    }
  }
}
