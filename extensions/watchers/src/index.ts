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
import type { Logger, Storage } from '@ethosagent/types';
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
}

export interface WatcherCreateInput {
  id: string;
  kind: WatcherKind;
  target: string;
  intervalSeconds: number;
  onChange: WatcherOnChange;
  owner?: WatcherOwner;
}

export interface WatcherWakeEvent {
  watcherId: string;
  target: string;
  personalityId: string;
  promptPrefix?: string;
  summary: string;
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
   *  watcher layer adds NO dedup of its own, per the adapter contract). */
  deliver?: (target: WatcherDeliverTarget, text: string) => Promise<void>;
  /** Bound at wiring time to lane message synthesis (webhook-wake style). */
  wake?: (event: WatcherWakeEvent) => Promise<void>;
  /** The approval-outbox questions every delivery asks (`dispatchChange`).
   *  Given at construction, so it exists before the first tick and a manager
   *  has exactly one. Consulted on every delivery, never cached, and its
   *  `refresh` is awaited first, so an `outbound_policy` edited on disk applies
   *  on the next tick. Absent = every stored `deliver` goes out. */
  deliveryGate?: WatcherDeliveryGate;
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
}

// ---------------------------------------------------------------------------
// WatcherManager
// ---------------------------------------------------------------------------

export class WatcherManager {
  private readonly storage: Storage;
  private readonly watchersDir: string;
  private readonly watchersPath: string;
  private readonly stateDir: string;
  private readonly logger: Logger;
  private readonly deliver?: (target: WatcherDeliverTarget, text: string) => Promise<void>;
  private readonly wake?: (event: WatcherWakeEvent) => Promise<void>;
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
    const watchers = await this.readWatchers();
    if (watchers.some((w) => w.id === input.id)) {
      throw new Error(`Watcher with id "${input.id}" already exists`);
    }
    const record: WatcherRecord = {
      id: input.id,
      kind: input.kind,
      target: input.target,
      intervalSeconds: input.intervalSeconds,
      onChange: input.onChange,
      enabled: true,
      createdAt: new Date().toISOString(),
      ...(input.owner ? { owner: input.owner } : {}),
    };
    watchers.push(record);
    await this.writeWatchers(watchers);
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
    const watchers = await this.readWatchers();
    const watcher = watchers.find((w) => w.id === id);
    if (!watcher) throw new Error(`Watcher not found: ${id}`);
    watcher.enabled = false;
    await this.writeWatchers(watchers);
    await this.deregisterJob(id);
  }

  async resumeWatcher(id: string): Promise<void> {
    const watchers = await this.readWatchers();
    const watcher = watchers.find((w) => w.id === id);
    if (!watcher) throw new Error(`Watcher not found: ${id}`);
    watcher.enabled = true;
    await this.writeWatchers(watchers);
    await this.registerJob(watcher);
  }

  /** Remove the watcher, its backing system job, and its persisted state. */
  async removeWatcher(id: string): Promise<void> {
    const watchers = await this.readWatchers();
    if (!watchers.some((w) => w.id === id)) throw new Error(`Watcher not found: ${id}`);
    await this.writeWatchers(watchers.filter((w) => w.id !== id));
    await this.deregisterJob(id);
    const statePath = this.statePath(id);
    if (await this.storage.exists(statePath)) {
      await this.storage.remove(statePath).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Tick — run the differ, dispatch on diff, persist state
  // -------------------------------------------------------------------------

  async tick(id: string): Promise<WatcherTickResult> {
    const watcher = await this.getWatcher(id);
    if (!watcher?.enabled) return { changed: false };

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

  /** Invoke deliver and/or wake (both may be set). Callback failures are
   *  logged, never thrown — a broken channel must not break the tick, and
   *  state still advances (at-least-once alerting is the accepted posture). */
  private async dispatchChange(watcher: WatcherRecord, summary: string): Promise<void> {
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
          await this.deliver(deliver, `[watcher ${watcher.id}] ${summary}`);
        } catch (err) {
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
          await this.wake({
            watcherId: watcher.id,
            target: watcher.target,
            personalityId: wake.personalityId,
            ...(wake.promptPrefix ? { promptPrefix: wake.promptPrefix } : {}),
            summary,
          });
        } catch (err) {
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
    const watchers = await this.readWatchers();
    const watcher = watchers.find((w) => w.id === id);
    if (!watcher) return;
    if (withheld) watcher.deliveryWithheld = withheld;
    else delete watcher.deliveryWithheld;
    await this.writeWatchers(watchers);
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
