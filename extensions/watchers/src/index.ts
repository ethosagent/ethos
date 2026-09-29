// Declarative watcher primitives (gap-event-triggers Phase 3).
//
// A watcher is a deterministic differ (file / http / rss / process) with
// persisted last-seen state that ticks as a `source:'system'` cron job on
// the existing CronScheduler — no second ticker, no LLM involvement. On a
// diff it invokes injected callbacks: `deliver` (verbatim channel send via
// the gateway's dedup-gated `sendTo`) and/or `wake` (synthesize a turn into
// the owning personality's lane). Both are bound at wiring time.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@ethosagent/logger';
import type { Logger, Storage, TurnAudience } from '@ethosagent/types';
import {
  createDefaultProcessProbe,
  type DiffOutcome,
  diffFile,
  diffHttp,
  diffProcess,
  diffRss,
  type ProcessProbe,
  type WatcherState,
} from './differs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WatcherKind = 'file' | 'http' | 'rss' | 'process';

/** Explicit delivery target — platform + chatId, never a captured origin
 *  (plan gap-event-triggers §5 risk 5: web-created watchers have no origin). */
export interface WatcherDeliverTarget {
  platform: string;
  chatId: string;
}

export interface WatcherWakeTarget {
  personalityId: string;
  promptPrefix?: string;
}

export interface WatcherOnChange {
  deliver?: WatcherDeliverTarget;
  wake?: WatcherWakeTarget;
}

/** The agent turn that created a watcher. Recorded by `watcher_create`
 *  (`@ethosagent/tools-watchers`) so a delivery can be re-checked against the
 *  creating personality's `outbound_policy` on every tick. */
export interface WatcherOwner {
  personalityId: string;
  /** `platform:chatId` of the creating turn (`ToolContext.origin`), when it had one. */
  origin?: string;
  /**
   * The creating turn's resolved room audience (`ToolContext.roomAudience`,
   * plan personality-memory-boundary G1-6), stamped by `watcher_create`.
   * Absent on owners recorded before the field existed. Read only by
   * `WatcherManager.wakeAudience`.
   */
  roomAudience?: TurnAudience;
}

/** Why the last change was not delivered, persisted on the record so
 *  `watcher_list` can show it. Cleared by the next delivery that goes out. */
export interface WatcherDeliveryWithheld {
  at: string;
  reason: string;
}

/**
 * The approval-outbox questions a delivery must ask (O-T12,
 * plan/phases/trust-before-reach.md): does this personality's
 * `outbound_policy.approve_before_send` gate this platform, and which chat is
 * the operator's own. Declared structurally — `createOutboundPolicyGate` in
 * `packages/wiring/src/compose-tools.ts` satisfies it, and each app root hands
 * one to its manager at construction (`WatcherManagerConfig.deliveryGate`).
 */
export interface WatcherDeliveryGate {
  gates(personalityId: string, platform: string): boolean;
  ownerTarget(platform: string): string | undefined;
  /**
   * Bring the policy source up to date before `gates` is asked. The manager
   * awaits it before every delivery decision (`WatcherManager.dispatchChange`),
   * because a watcher fires off the cron tick with no turn in between to
   * reload personalities. A rejection is logged and the last-loaded policy
   * answers. Absent = the policy source is already current.
   */
  refresh?(): Promise<void>;
}

/**
 * True when `target` would publish a gated personality's watcher output to a
 * third party. The one predicate behind both the creation refusal
 * (`watcher_create`) and the delivery-time hold (`WatcherManager.dispatchChange`).
 *
 * The two exempt destinations are the ones the `send_message` gate exempts: the
 * creating turn's own chat is the conversation, and the operator's own chat is
 * the person who would be approving.
 */
export function isForeignDeliverForGatedOwner(
  gate: WatcherDeliveryGate,
  owner: WatcherOwner,
  target: WatcherDeliverTarget,
): boolean {
  if (!gate.gates(owner.personalityId, target.platform)) return false;
  if (owner.origin !== undefined && `${target.platform}:${target.chatId}` === owner.origin) {
    return false;
  }
  return target.chatId !== gate.ownerTarget(target.platform);
}

/**
 * "Until Z" on a standing intent (plan personality-presence-and-initiative §5).
 * Enforced in one place, `WatcherManager.dispatchChange`; validated by
 * `validateWatcherInput`.
 */
export interface WatcherLimits {
  /** ISO-8601 instant. A change after it pauses the watcher instead of firing. */
  expiresAt?: string;
  /** A change within this many seconds of the last fire advances state but
   *  fires nothing. */
  cooldownSeconds?: number;
  /** Fires allowed before the watcher pauses. Absent = `DEFAULT_WATCHER_MAX_FIRES`
   *  for a watcher with an owner, unlimited for one without (`effectiveMaxFires`).
   *  `0` = unlimited, and only a watcher with no owner — one an operator created
   *  outside an agent turn — may carry it; an owned watcher may carry at most
   *  `MAX_AGENT_WATCHER_FIRES` (`validateWatcherInput`). */
  maxFires?: number;
}

/** Why the manager paused a watcher (expiry or spent budget), persisted so
 *  `watcher_list` can show it. Cleared by `resumeWatcher`. */
export interface WatcherStopped {
  at: string;
  reason: string;
}

export interface WatcherRecord {
  id: string;
  kind: WatcherKind;
  /** Path (file), URL (http/rss), or pid-file path / process name (process). */
  target: string;
  /** Tick interval; minimum 60 — ticks piggyback on the 60s cron scheduler. */
  intervalSeconds: number;
  onChange: WatcherOnChange;
  /** Paused watchers keep their record + state but have no backing job. */
  enabled: boolean;
  createdAt: string;
  /** Absent on records created outside an agent turn, and on records written
   *  before owners were stored — neither can be re-checked against a policy. */
  owner?: WatcherOwner;
  deliveryWithheld?: WatcherDeliveryWithheld;
  limits?: WatcherLimits;
  /** Changes that woke or delivered. Absent on records that never fired. */
  firesUsed?: number;
  /** When the last counted fire happened — the cooldown's reference point. */
  lastFiredAt?: string;
  stopped?: WatcherStopped;
}

export interface WatcherCreateInput {
  id: string;
  kind: WatcherKind;
  target: string;
  intervalSeconds: number;
  onChange: WatcherOnChange;
  owner?: WatcherOwner;
  limits?: WatcherLimits;
}

export interface WatcherWakeEvent {
  watcherId: string;
  target: string;
  personalityId: string;
  promptPrefix?: string;
  summary: string;
  /**
   * The room audience the woken turn runs under, stamped by the manager
   * (`WatcherManager.wakeAudience`): shared when the watcher has no owner,
   * when its creating turn was shared, or when its origin chat or delivery
   * target is not provably private. Every wake site passes it on — the
   * gateway-routed ones as `InboundMessage.audienceHint`, `ethos serve`'s as
   * `RunOptions.roomAudience`.
   */
  roomAudience: TurnAudience;
}

export interface WatcherTickResult {
  changed: boolean;
  summary?: string;
}

/**
 * Minimal structural slice of `CronScheduler` the manager drives. Kept as a
 * port so `@ethosagent/watchers` needs no dependency on `@ethosagent/cron` —
 * the concrete scheduler satisfies it at wiring time.
 */
export interface WatcherSchedulerPort {
  seedSystemJob(params: {
    name: string;
    schedule: string;
    systemTask: string;
    personalityId?: string;
  }): Promise<unknown>;
  removeSystemJob(id: string): Promise<void>;
}

export interface WatcherManagerConfig {
  /** Storage backend for watchers.json + per-watcher state. Required. */
  storage: Storage;
  /** Directory for watchers.json and state/. Defaults to ~/.ethos/watchers/. */
  watchersDir?: string;
  logger?: Logger;
  /** Bound at wiring time to `Gateway.sendTo` (already dedup-gated — the
   *  watcher layer adds NO dedup of its own, per the adapter contract).
   *  Resolving `false` reports that nothing was sent, and the change costs no
   *  fire (`WatcherManager.dispatchChange`). */
  deliver?: (target: WatcherDeliverTarget, text: string) => Promise<boolean | undefined>;
  /** Bound at wiring time to lane message synthesis (webhook-wake style).
   *  Resolving `false` reports that no turn was started (no bot for the
   *  personality, no loop yet), and the change costs no fire. */
  wake?: (event: WatcherWakeEvent) => Promise<boolean | undefined>;
  /** The approval-outbox questions every delivery asks (`dispatchChange`).
   *  Given at construction, so it exists before the first tick and a manager
   *  has exactly one. Consulted on every delivery, never cached, and its
   *  `refresh` is awaited first, so an `outbound_policy` edited on disk applies
   *  on the next tick. Absent = every stored `deliver` goes out. */
  deliveryGate?: WatcherDeliveryGate;
  /**
   * Whether a message to `platform:chatId` is read by one person — bound at
   * wiring time to `targetAudience` (packages/core/src/chat-audience.ts) over
   * the operator's `gateway.private_chats`. Used by `wakeAudience` for a
   * watcher's origin chat and delivery target. Absent → every chat counts as
   * shared (fail closed).
   */
  targetAudience?: (platform: string, chatId: string) => TurnAudience;
  /** Injected fetch for http/rss differs. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injected alive-probe for process watchers. Defaults to pid / pid-file /
   *  pgrep observation. */
  processProbe?: ProcessProbe;
}

// ---------------------------------------------------------------------------
// Constants + validation
// ---------------------------------------------------------------------------

/** The single systemTask name every watcher-backed cron job dispatches to. */
export const WATCHER_SYSTEM_TASK = 'watcher-tick';
export const MIN_INTERVAL_SECONDS = 60;
/** The fire budget an OWNED watcher gets when none is given — including every
 *  owned record written before limits existed (`effectiveMaxFires`). */
export const DEFAULT_WATCHER_MAX_FIRES = 20;
/** The largest fire budget an owned (agent-created) watcher may carry
 *  (`validateWatcherInput`; `watcher_create` refuses above it first). */
export const MAX_AGENT_WATCHER_FIRES = 100;
/** Enabled watchers one personality may own at once (`WatcherManager.createWatcher`,
 *  `WatcherManager.resumeWatcher`). Paused watchers do not count. */
export const MAX_WATCHERS_PER_OWNER = 10;

/**
 * The fire budget `WatcherManager` enforces for `watcher`; `0` = unlimited. An
 * explicit `limits.maxFires` always wins. Without one, an owned (agent-created)
 * watcher gets `DEFAULT_WATCHER_MAX_FIRES`, and an owner-less one — created by
 * the operator outside an agent turn, or written before limits existed — keeps
 * the unlimited behavior it had before limits were introduced.
 */
export function effectiveMaxFires(watcher: Pick<WatcherRecord, 'limits' | 'owner'>): number {
  const explicit = watcher.limits?.maxFires;
  if (explicit !== undefined) return explicit;
  return watcher.owner ? DEFAULT_WATCHER_MAX_FIRES : 0;
}

/** Strict ISO-8601 date-time with a `Z` or `±hh:mm` zone. A bare date, a
 *  zone-less time (read in whatever zone the host runs in) and anything
 *  `Date.parse` merely tolerates ("October 1") are refused. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Backing cron-job id prefix. The id round-trips through the scheduler's
 *  slugifier, so watcher ids are restricted to lowercase alphanumerics and
 *  hyphens (no underscores — the slugifier would rewrite them). */
const WATCHER_JOB_PREFIX = 'watcher-';
const WATCHER_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const WATCHER_KINDS: readonly WatcherKind[] = ['file', 'http', 'rss', 'process'];

export function validateWatcherInput(input: WatcherCreateInput): void {
  if (!WATCHER_ID_RE.test(input.id)) {
    throw new Error(
      `Invalid watcher id "${input.id}" — use 1-48 lowercase letters, digits, and hyphens (must start alphanumeric)`,
    );
  }
  if (!WATCHER_KINDS.includes(input.kind)) {
    throw new Error(`Invalid watcher kind "${input.kind}" — one of: ${WATCHER_KINDS.join(', ')}`);
  }
  if (typeof input.target !== 'string' || input.target.trim() === '') {
    throw new Error('target is required');
  }
  if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < MIN_INTERVAL_SECONDS) {
    throw new Error(
      `intervalSeconds must be an integer >= ${MIN_INTERVAL_SECONDS} (the scheduler ticks every 60s; use OS cron + webhooks for sub-minute polls)`,
    );
  }
  const { deliver, wake } = input.onChange ?? {};
  if (!deliver && !wake) {
    throw new Error('onChange requires at least one of deliver or wake');
  }
  if (deliver && (!deliver.platform?.trim() || !deliver.chatId?.trim())) {
    throw new Error('deliver requires explicit platform and chatId');
  }
  if (wake && !wake.personalityId?.trim()) {
    throw new Error('wake requires personalityId');
  }
  const limits = input.limits;
  if (limits === undefined) return;
  if (
    limits.expiresAt !== undefined &&
    (typeof limits.expiresAt !== 'string' ||
      !ISO_INSTANT_RE.test(limits.expiresAt) ||
      Number.isNaN(Date.parse(limits.expiresAt)))
  ) {
    throw new Error(
      `limits.expiresAt "${limits.expiresAt}" is not an ISO-8601 date-time with a zone, e.g. 2026-10-01T09:00:00Z or 2026-10-01T09:00:00+05:30`,
    );
  }
  if (
    limits.cooldownSeconds !== undefined &&
    (!Number.isInteger(limits.cooldownSeconds) || limits.cooldownSeconds < 0)
  ) {
    throw new Error('limits.cooldownSeconds must be an integer >= 0');
  }
  if (limits.maxFires !== undefined) {
    if (!Number.isInteger(limits.maxFires) || limits.maxFires < 0) {
      throw new Error('limits.maxFires must be an integer >= 0');
    }
    // An owner is stamped only by `watcher_create` (`@ethosagent/tools-watchers`),
    // i.e. an agent turn. No agent-created watcher may wake without limit.
    if (limits.maxFires === 0 && input.owner) {
      throw new Error(
        'limits.maxFires: 0 (unlimited) is operator-only — a watcher created by an agent must have a fire budget',
      );
    }
    if (input.owner && limits.maxFires > MAX_AGENT_WATCHER_FIRES) {
      throw new Error(
        `limits.maxFires must be at most ${MAX_AGENT_WATCHER_FIRES} for a watcher created by an agent`,
      );
    }
  }
}

/**
 * One queue per watchers.json path, shared by every manager in the process, so
 * each read-modify-write of the file runs alone (`WatcherManager.serialize`).
 */
const rmwQueues = new Map<string, Promise<unknown>>();

// ---------------------------------------------------------------------------
// WatcherManager
// ---------------------------------------------------------------------------

export class WatcherManager {
  private readonly storage: Storage;
  private readonly watchersDir: string;
  private readonly watchersPath: string;
  private readonly stateDir: string;
  private readonly logger: Logger;
  private readonly deliver?: (
    target: WatcherDeliverTarget,
    text: string,
  ) => Promise<boolean | undefined>;
  private readonly wake?: (event: WatcherWakeEvent) => Promise<boolean | undefined>;
  private readonly targetAudience?: (platform: string, chatId: string) => TurnAudience;
  private readonly fetchFn: typeof fetch;
  private readonly processProbe: ProcessProbe;
  private scheduler: WatcherSchedulerPort | null = null;
  private readonly deliveryGate: WatcherDeliveryGate | undefined;

  constructor(config: WatcherManagerConfig) {
    this.storage = config.storage;
    this.watchersDir = config.watchersDir ?? join(homedir(), '.ethos', 'watchers');
    this.watchersPath = join(this.watchersDir, 'watchers.json');
    this.stateDir = join(this.watchersDir, 'state');
    this.logger = config.logger ?? noopLogger;
    this.deliver = config.deliver;
    this.wake = config.wake;
    this.targetAudience = config.targetAudience;
    this.deliveryGate = config.deliveryGate;
    this.fetchFn = config.fetchFn ?? fetch;
    this.processProbe = config.processProbe ?? createDefaultProcessProbe(config.storage);
  }

  /**
   * The systemTask handler record to merge into `CronSchedulerConfig.systemTasks`
   * at scheduler construction. One task name serves every watcher; the backing
   * job's id (`watcher-<id>`) identifies which watcher to tick.
   */
  systemTasks(): Record<string, (job: { id: string }) => Promise<{ output: string }>> {
    return {
      [WATCHER_SYSTEM_TASK]: async (job) => {
        if (!job.id.startsWith(WATCHER_JOB_PREFIX)) return { output: '' };
        const result = await this.tick(job.id.slice(WATCHER_JOB_PREFIX.length));
        return { output: result.changed ? (result.summary ?? 'change detected') : '' };
      },
    };
  }

  /** Late-bind the scheduler (it is constructed after the manager because its
   *  `systemTasks` config includes this manager's handler). */
  attachScheduler(scheduler: WatcherSchedulerPort): void {
    this.scheduler = scheduler;
  }

  /** Load watchers.json and (re-)register backing system jobs for every
   *  enabled watcher. Idempotent — safe on every boot. */
  async start(): Promise<void> {
    const watchers = await this.readWatchers();
    for (const watcher of watchers) {
      if (watcher.enabled) await this.registerJob(watcher);
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle — create / list / pause / resume / remove
  // -------------------------------------------------------------------------

  async createWatcher(input: WatcherCreateInput): Promise<WatcherRecord> {
    validateWatcherInput(input);
    const record = await this.serialize(async () => {
      const watchers = await this.readWatchers();
      if (watchers.some((w) => w.id === input.id)) {
        throw new Error(`Watcher with id "${input.id}" already exists`);
      }
      if (input.owner) this.assertOwnerHasRoom(watchers, input.owner.personalityId);
      const created: WatcherRecord = {
        id: input.id,
        kind: input.kind,
        target: input.target,
        intervalSeconds: input.intervalSeconds,
        onChange: input.onChange,
        enabled: true,
        createdAt: new Date().toISOString(),
        ...(input.owner ? { owner: input.owner } : {}),
        limits: { ...input.limits, maxFires: effectiveMaxFires(input) },
      };
      watchers.push(created);
      await this.writeWatchers(watchers);
      return created;
    });
    await this.registerJob(record);
    return record;
  }

  async listWatchers(): Promise<WatcherRecord[]> {
    return this.readWatchers();
  }

  async getWatcher(id: string): Promise<WatcherRecord | null> {
    const watchers = await this.readWatchers();
    return watchers.find((w) => w.id === id) ?? null;
  }

  /** Pause: deregister the backing system job and mark disabled. State is
   *  kept, so resume continues detection from the last-seen snapshot. */
  async pauseWatcher(id: string): Promise<void> {
    await this.serialize(async () => {
      const watchers = await this.readWatchers();
      const watcher = watchers.find((w) => w.id === id);
      if (!watcher) throw new Error(`Watcher not found: ${id}`);
      watcher.enabled = false;
      await this.writeWatchers(watchers);
    });
    await this.deregisterJob(id);
  }

  async resumeWatcher(id: string): Promise<void> {
    const watcher = await this.serialize(async () => {
      const watchers = await this.readWatchers();
      const found = watchers.find((w) => w.id === id);
      if (!found) throw new Error(`Watcher not found: ${id}`);
      if (!found.enabled && found.owner) {
        this.assertOwnerHasRoom(watchers, found.owner.personalityId);
      }
      found.enabled = true;
      delete found.stopped;
      await this.writeWatchers(watchers);
      return found;
    });
    await this.registerJob(watcher);
  }

  /** Remove the watcher, its backing system job, and its persisted state. */
  async removeWatcher(id: string): Promise<void> {
    await this.serialize(async () => {
      const watchers = await this.readWatchers();
      if (!watchers.some((w) => w.id === id)) throw new Error(`Watcher not found: ${id}`);
      await this.writeWatchers(watchers.filter((w) => w.id !== id));
    });
    await this.deregisterJob(id);
    const statePath = this.statePath(id);
    if (await this.storage.exists(statePath)) {
      await this.storage.remove(statePath).catch(() => {});
    }
  }

  /** The per-owner cap (`MAX_WATCHERS_PER_OWNER`): throws when `personalityId`
   *  already owns that many ENABLED watchers. Called inside `serialize`. */
  private assertOwnerHasRoom(watchers: WatcherRecord[], personalityId: string): void {
    const active = watchers.filter(
      (w) => w.enabled && w.owner?.personalityId === personalityId,
    ).length;
    if (active >= MAX_WATCHERS_PER_OWNER) {
      throw new Error(
        `personality "${personalityId}" already has ${active} active watchers — the limit is ${MAX_WATCHERS_PER_OWNER}. Pause or delete one first.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Tick — run the differ, dispatch on diff, persist state
  // -------------------------------------------------------------------------

  async tick(id: string): Promise<WatcherTickResult> {
    const watcher = await this.getWatcher(id);
    if (!watcher?.enabled) return { changed: false };

    // Expiry and a spent budget are checked on EVERY tick, before the differ,
    // so a watcher whose target never changes again still pauses (and stops
    // polling) once it has expired. `claimFire` asks again at fire time.
    const stop = this.stopReason(watcher, Date.now());
    if (stop) {
      await this.stopWatcher(id, stop, Date.now());
      return { changed: false };
    }

    const prev = await this.readState(watcher);
    const outcome = await this.runDiffer(watcher, prev);

    if (outcome.error) {
      // Observation errors are NOT a change: log, keep prior state.
      this.logger.warn(`[watchers] observation failed for "${watcher.id}"`, {
        component: 'watchers',
        watcherId: watcher.id,
        error: outcome.error,
      });
      return { changed: false };
    }

    if (outcome.changed && outcome.summary) {
      await this.dispatchChange(watcher, outcome.summary);
    }

    // Persist only the initial seed and real transitions — an unchanged tick
    // writes nothing (test-enforced: two unchanged ticks = one write total).
    if (outcome.state && (prev === null || outcome.changed)) {
      await this.writeState(watcher.id, outcome.state);
    }

    return outcome.changed
      ? { changed: true, ...(outcome.summary ? { summary: outcome.summary } : {}) }
      : { changed: false };
  }

  private async runDiffer(watcher: WatcherRecord, prev: WatcherState | null): Promise<DiffOutcome> {
    switch (watcher.kind) {
      case 'file':
        return diffFile(watcher.target, prev?.kind === 'file' ? prev : null, this.storage);
      case 'http':
        return diffHttp(watcher.target, prev?.kind === 'http' ? prev : null, this.fetchFn);
      case 'rss':
        return diffRss(watcher.target, prev?.kind === 'rss' ? prev : null, this.fetchFn);
      case 'process':
        return diffProcess(
          watcher.target,
          prev?.kind === 'process' ? prev : null,
          this.processProbe,
        );
    }
  }

  /**
   * The audience a wake from `watcher` runs under (plan
   * personality-memory-boundary G1-6). `'shared'` if ANY of: the watcher has
   * no owner (created outside a turn — nothing proves it private); its owner
   * was stamped shared; its owner predates the stamp and its origin chat is
   * not provably private; its delivery target is not provably private (the
   * woken agent writes for that room). `'private'` otherwise. Pinned by
   * `__tests__/wake-audience.test.ts`.
   */
  private wakeAudience(watcher: WatcherRecord): TurnAudience {
    const owner = watcher.owner;
    if (!owner || owner.roomAudience === 'shared') return 'shared';
    const classify = (platform: string, chatId: string): TurnAudience =>
      this.targetAudience?.(platform, chatId) ?? 'shared';
    if (owner.roomAudience === undefined && owner.origin !== undefined) {
      const colon = owner.origin.indexOf(':');
      if (colon <= 0) return 'shared';
      const platform = owner.origin.slice(0, colon);
      if (classify(platform, owner.origin.slice(colon + 1)) === 'shared') return 'shared';
    }
    const deliver = watcher.onChange.deliver;
    if (deliver && classify(deliver.platform, deliver.chatId) === 'shared') return 'shared';
    return 'private';
  }

  /** Invoke deliver and/or wake (both may be set). Callback failures are
   *  logged, never thrown — a broken channel must not break the tick, and
   *  state still advances (at-least-once alerting is the accepted posture).
   *
   *  The watcher's limits are enforced here and at the top of `tick`: expired
   *  or out of budget → paused with `stopped` recorded, nothing fires; inside
   *  the cooldown → nothing fires (the caller still advances state).
   *
   *  A fire is RESERVED before any callback runs (`claimFire`, one serialized
   *  read-modify-write), so two overlapping ticks cannot both spend the last
   *  unit of budget. The reservation is returned (`refundFire`) when nothing
   *  went out: a withheld deliver, a refused foreign wake, no callback wired,
   *  or a callback that resolved `false` (it reports it started nothing). A
   *  callback that THROWS keeps the fire — a turn may have run before the
   *  throw, and a watcher whose wake always fails must not wake without limit.
   *  Pinned by `__tests__/limits.test.ts`. */
  private async dispatchChange(watcher: WatcherRecord, summary: string): Promise<void> {
    const now = Date.now();
    const claim = await this.claimFire(watcher.id, now);
    if (!claim.ok) return;
    let fired = false;
    const { deliver, wake } = watcher.onChange;
    if (deliver) await this.refreshDeliveryGate(watcher.id);
    const withheld = deliver ? this.withheldReason(watcher, deliver) : undefined;
    if (withheld) {
      this.logger.warn(`[watchers] delivery withheld for "${watcher.id}"`, {
        component: 'watchers',
        watcherId: watcher.id,
        reason: withheld,
      });
      await this.setDeliveryWithheld(watcher.id, {
        at: new Date().toISOString(),
        reason: withheld,
      });
    } else if (deliver) {
      if (watcher.deliveryWithheld) await this.setDeliveryWithheld(watcher.id, undefined);
      if (this.deliver) {
        try {
          fired = (await this.deliver(deliver, `[watcher ${watcher.id}] ${summary}`)) !== false;
        } catch (err) {
          fired = true;
          this.logger.error(`[watchers] delivery failed for "${watcher.id}"`, {
            component: 'watchers',
            watcherId: watcher.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        this.logger.warn(`[watchers] no deliver callback wired — "${watcher.id}" change dropped`, {
          component: 'watchers',
          watcherId: watcher.id,
        });
      }
    }
    // A wake is always self (S5): `watcher_create` (`@ethosagent/tools-watchers`)
    // refuses a foreign one, and a record stored before that refusal existed is
    // stopped here with a named reason. A record with no owner names no
    // personality to compare against and still wakes.
    if (wake && watcher.owner && wake.personalityId !== watcher.owner.personalityId) {
      this.logger.warn(
        `[watchers] wake of "${wake.personalityId}" refused: this watcher belongs to personality ` +
          `"${watcher.owner.personalityId}", and a watcher can only wake the personality that ` +
          `created it. Recreate "${watcher.id}" from that personality.`,
        { component: 'watchers', watcherId: watcher.id },
      );
    } else if (wake) {
      if (this.wake) {
        try {
          const woke = await this.wake({
            watcherId: watcher.id,
            target: watcher.target,
            personalityId: wake.personalityId,
            ...(wake.promptPrefix ? { promptPrefix: wake.promptPrefix } : {}),
            summary,
            roomAudience: this.wakeAudience(watcher),
          });
          if (woke !== false) fired = true;
        } catch (err) {
          fired = true;
          this.logger.error(`[watchers] wake failed for "${watcher.id}"`, {
            component: 'watchers',
            watcherId: watcher.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        this.logger.warn(`[watchers] no wake callback wired — "${watcher.id}" change dropped`, {
          component: 'watchers',
          watcherId: watcher.id,
        });
      }
    }
    if (!fired) await this.refundFire(watcher.id, claim.stamp, claim.previousLastFiredAt);
  }

  /**
   * Reserve one fire for `id` at `now`, against the record as it is on disk
   * NOW (not the tick's earlier snapshot). Refused when the watcher was paused
   * or removed meanwhile, is inside its cooldown, or has expired / spent its
   * budget — the last case pauses it with the reason.
   */
  private async claimFire(
    id: string,
    now: number,
  ): Promise<{ ok: true; stamp: string; previousLastFiredAt: string | undefined } | { ok: false }> {
    const outcome = await this.serialize(async () => {
      const watchers = await this.readWatchers();
      const watcher = watchers.find((w) => w.id === id);
      if (!watcher?.enabled) return { kind: 'refused' as const };
      const stop = this.stopReason(watcher, now);
      if (stop) return { kind: 'stop' as const, reason: stop };
      const cooldownMs = (watcher.limits?.cooldownSeconds ?? 0) * 1000;
      if (watcher.lastFiredAt && now - Date.parse(watcher.lastFiredAt) < cooldownMs) {
        return { kind: 'cooldown' as const };
      }
      const previousLastFiredAt = watcher.lastFiredAt;
      const stamp = new Date(now).toISOString();
      watcher.firesUsed = (watcher.firesUsed ?? 0) + 1;
      watcher.lastFiredAt = stamp;
      await this.writeWatchers(watchers);
      return { kind: 'claimed' as const, stamp, previousLastFiredAt };
    });
    switch (outcome.kind) {
      case 'claimed':
        return { ok: true, stamp: outcome.stamp, previousLastFiredAt: outcome.previousLastFiredAt };
      case 'stop':
        await this.stopWatcher(id, outcome.reason, now);
        return { ok: false };
      case 'cooldown':
        this.logger.info(`[watchers] "${id}" change inside cooldown — not dispatched`, {
          component: 'watchers',
          watcherId: id,
        });
        return { ok: false };
      case 'refused':
        return { ok: false };
    }
  }

  /** Return a reserved fire that sent nothing. `lastFiredAt` is restored only
   *  if no later fire has stamped it since. */
  private async refundFire(
    id: string,
    stamp: string,
    previousLastFiredAt: string | undefined,
  ): Promise<void> {
    await this.updateRecord(id, (w) => {
      w.firesUsed = Math.max(0, (w.firesUsed ?? 0) - 1);
      if (w.lastFiredAt !== stamp) return;
      if (previousLastFiredAt === undefined) delete w.lastFiredAt;
      else w.lastFiredAt = previousLastFiredAt;
    });
  }

  /** Pause `id` because it expired or spent its budget, recording why. */
  private async stopWatcher(id: string, reason: string, now: number): Promise<void> {
    this.logger.warn(`[watchers] "${id}" paused: ${reason}`, {
      component: 'watchers',
      watcherId: id,
    });
    await this.updateRecord(id, (w) => {
      w.enabled = false;
      w.stopped = { at: new Date(now).toISOString(), reason };
    });
    await this.deregisterJob(id);
  }

  /** Why `watcher` may not fire at `now` and must pause, or `undefined`. */
  private stopReason(watcher: WatcherRecord, now: number): string | undefined {
    const expiresAt = watcher.limits?.expiresAt;
    if (expiresAt !== undefined && now >= Date.parse(expiresAt)) {
      return `expired at ${expiresAt}; paused instead of firing.`;
    }
    const maxFires = effectiveMaxFires(watcher);
    const used = watcher.firesUsed ?? 0;
    if (maxFires > 0 && used >= maxFires) {
      return `fire budget spent (${used} of ${maxFires}); paused instead of firing.`;
    }
    return undefined;
  }

  /** Read-modify-write one record in watchers.json; a missing id is a no-op. */
  private async updateRecord(id: string, mutate: (watcher: WatcherRecord) => void): Promise<void> {
    await this.serialize(async () => {
      const watchers = await this.readWatchers();
      const watcher = watchers.find((w) => w.id === id);
      if (!watcher) return;
      mutate(watcher);
      await this.writeWatchers(watchers);
    });
  }

  /**
   * Run one read-modify-write of watchers.json with no other in THIS process
   * interleaved (`rmwQueues`, keyed by the file path, so two managers on one
   * file share a queue). Every write of watchers.json goes through here, and
   * nothing inside `fn` may call back into a serialized method (it would wait
   * on itself) — so no callback (deliver, wake) ever runs inside it.
   *
   * LIMITATION — in-process only. Two PROCESSES on one state dir (`ethos serve`
   * beside `ethos gateway start`; `acquireGatewayLock` excludes only a second
   * gateway) can still interleave a read-modify-write and lose an update: a
   * `firesUsed` increment, a pause, a new record. A cross-process lock needs a
   * raw `node:fs` exclusive create (`withJobsFileLock` in
   * `extensions/cron/src/jobs-lock.ts` is the precedent), which is a new
   * storage carve-out this package does not have.
   */
  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const prior = rmwQueues.get(this.watchersPath) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    rmwQueues.set(this.watchersPath, settled);
    try {
      return await run;
    } finally {
      if (rmwQueues.get(this.watchersPath) === settled) rmwQueues.delete(this.watchersPath);
    }
  }

  /** Reload the gate's policy source before a delivery decision. Failure keeps
   *  the last-loaded policy — the same last-good posture the gateway's
   *  per-turn personality refresh takes — and says so in the log. */
  private async refreshDeliveryGate(watcherId: string): Promise<void> {
    if (!this.deliveryGate?.refresh) return;
    try {
      await this.deliveryGate.refresh();
    } catch (err) {
      this.logger.warn(`[watchers] policy refresh failed for "${watcherId}" — using last-loaded`, {
        component: 'watchers',
        watcherId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The reason a stored `deliver` may not go out now, or `undefined`. Re-read
   *  on every change: the owner's policy may have been switched on after the
   *  watcher was created, when `watcher_create`'s refusal could not see it. */
  private withheldReason(watcher: WatcherRecord, target: WatcherDeliverTarget): string | undefined {
    const owner = watcher.owner;
    if (!this.deliveryGate || !owner) return undefined;
    if (!isForeignDeliverForGatedOwner(this.deliveryGate, owner, target)) return undefined;
    return (
      `Delivery to ${target.platform}:${target.chatId} withheld: personality ` +
      `"${owner.personalityId}" publishes only through the approval outbox ` +
      `(outbound_policy.approve_before_send), and this watcher's deliver would send the change ` +
      `verbatim with nobody reviewing it. Recreate the watcher with wake instead: the woken ` +
      `personality's send_message is queued for approval like any other publication.`
    );
  }

  private async setDeliveryWithheld(
    id: string,
    withheld: WatcherDeliveryWithheld | undefined,
  ): Promise<void> {
    await this.updateRecord(id, (watcher) => {
      if (withheld) watcher.deliveryWithheld = withheld;
      else delete watcher.deliveryWithheld;
    });
  }

  // -------------------------------------------------------------------------
  // Backing system jobs — piggyback on the CronScheduler, no second ticker
  // -------------------------------------------------------------------------

  private backingJobId(id: string): string {
    return `${WATCHER_JOB_PREFIX}${id}`;
  }

  /** Remove-then-seed so an interval change on re-registration takes effect
   *  (seedSystemJob returns an existing job unchanged). */
  private async registerJob(watcher: WatcherRecord): Promise<void> {
    if (!this.scheduler) return;
    const jobId = this.backingJobId(watcher.id);
    await this.scheduler.removeSystemJob(jobId);
    await this.scheduler.seedSystemJob({
      name: jobId,
      schedule: `every ${watcher.intervalSeconds}s`,
      systemTask: WATCHER_SYSTEM_TASK,
    });
  }

  private async deregisterJob(id: string): Promise<void> {
    if (!this.scheduler) return;
    await this.scheduler.removeSystemJob(this.backingJobId(id));
  }

  // -------------------------------------------------------------------------
  // Persistence — watchers.json + state/<id>.json, all via Storage
  // -------------------------------------------------------------------------

  private statePath(id: string): string {
    return join(this.stateDir, `${id}.json`);
  }

  private async readWatchers(): Promise<WatcherRecord[]> {
    const raw = await this.storage.read(this.watchersPath);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as WatcherRecord[]) : [];
    } catch {
      return [];
    }
  }

  private async writeWatchers(watchers: WatcherRecord[]): Promise<void> {
    await this.storage.mkdir(this.watchersDir);
    await this.storage.writeAtomic(this.watchersPath, JSON.stringify(watchers, null, 2));
  }

  private async readState(watcher: WatcherRecord): Promise<WatcherState | null> {
    const raw = await this.storage.read(this.statePath(watcher.id));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as WatcherState;
      // Kind mismatch (watcher recreated as a different kind) → reseed.
      return parsed.kind === watcher.kind ? parsed : null;
    } catch {
      return null;
    }
  }

  /** State writes are atomic — a partial state file would cause duplicate
   *  alerts on the next tick (plan §5 risk 4; at-least-once accepted). */
  private async writeState(id: string, state: WatcherState): Promise<void> {
    await this.storage.mkdir(this.stateDir);
    await this.storage.writeAtomic(this.statePath(id), JSON.stringify(state, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  DiffOutcome,
  FileWatcherState,
  HttpWatcherState,
  ProcessProbe,
  ProcessWatcherState,
  RssWatcherState,
  WatcherState,
} from './differs';
export { MAX_SEEN_GUIDS, parseFeedItems, sha256 } from './differs';
