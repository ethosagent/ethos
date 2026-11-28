import type {
  Constitution,
  DraftRow,
  InitiativeConfigPort,
  InitiativeRow,
  InitiativeStore,
} from '@ethosagent/types';
import { parse } from 'yaml';
import type { InitiativeFile, InitiativeSettings } from './config-schema';
import { MAX_SELF_STARTED_DEFAULT, SELF_START_POOL_USD_DEFAULT } from './config-service';

/** An agent initiative that goes silent for this long is paused (Decided: self-start). */
export const AUTO_PAUSE_DAYS = 14;
/** A scan is charged to its parent's day but never costs more than this. */
export const SCAN_CAP_USD = 0.25;
/** Below this much pool left, a new self-start is refused: it could not fund one window. */
export const MIN_SELF_START_USD = 0.1;

const DAY_MS = 86_400_000;
type Record_ = Record<string, unknown>;

/** What a run (or the digest) needs from the store for self-start. */
export type SelfStartStore = Pick<
  InitiativeStore,
  | 'list'
  | 'getInitiative'
  | 'drafts'
  | 'settleDraft'
  | 'reactionClock'
  | 'transitionInitiative'
  | 'budget'
>;

export interface SelfStartDeps {
  store: SelfStartStore;
  /** InitiativeConfigService: the only writer of `initiatives/*.yaml`. */
  config: InitiativeConfigPort;
  settings(personalityId: string): Promise<InitiativeSettings>;
  constitution(): Promise<Constitution>;
  /** The validated, clamped file of an initiative (the runner's loader); null when unknown. */
  load(initiativeId: string): Promise<{ file: InitiativeFile } | null>;
  personalityIds(): string[];
  now(): Date;
  onError?(err: unknown): void;
}

/** What happened to one draft. `suggested` leaves it pending: the digest shows it to the owner. */
export interface DraftOutcome {
  draftId: string;
  status: 'materialised' | 'refused' | 'suggested';
  reason: string | null;
  initiativeId?: string;
}

const isRecord = (v: unknown): v is Record_ =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function slug(s: string): string {
  return normalise(s).replace(/ /g, '-').slice(0, 48);
}

function guidanceText(g: unknown): string | null {
  if (typeof g === 'string') return g;
  return isRecord(g) && typeof g.text === 'string' ? g.text : null;
}

export function createSelfStart(deps: SelfStartDeps) {
  const { store } = deps;

  const agentRows = (): InitiativeRow[] =>
    deps
      .personalityIds()
      .flatMap((id) => store.list({ personalityId: id }).filter((r) => r.origin === 'agent'));

  async function pool(): Promise<{ usd: number; max: number }> {
    const c = (await deps.constitution()).initiatives;
    return {
      usd: c?.selfStartPoolUsdPerDay ?? SELF_START_POOL_USD_DEFAULT,
      max: c?.maxSelfStarted ?? MAX_SELF_STARTED_DEFAULT,
    };
  }

  /**
   * Pool left to hand a NEW agent initiative: the pool minus the `usd_per_day` of every agent
   * initiative still running (self_started, or kept and active). A paused or ended one holds
   * nothing. An initiative whose file cannot be read holds the whole pool, so a broken file
   * never lets the total creep past the operator's number.
   */
  async function allocatableUsd(): Promise<number> {
    const { usd } = await pool();
    let held = 0;
    for (const row of agentRows()) {
      if (row.state !== 'self_started' && row.state !== 'active') continue;
      try {
        const loaded = await deps.load(row.id);
        held += loaded ? loaded.file.budget.usd_per_day : usd;
      } catch (err) {
        deps.onError?.(err);
        held += usd;
      }
    }
    return Math.max(0, usd - held);
  }

  /**
   * What the shared pool still allows TODAY across every agent initiative: pool minus what all
   * of them already spent. This is the runtime half of the pool total; `allocatableUsd` is the
   * allocation half. A run charges only its own initiative's windows, never a human one's.
   */
  async function poolRemainingTodayUsd(day: string): Promise<number> {
    const { usd } = await pool();
    const spent = agentRows().reduce((n, r) => n + store.budget(r.id, day).spentUsd, 0);
    return Math.max(0, usd - spent);
  }

  function idleSince(id: string): string | null {
    const clock = store.reactionClock(id);
    if (!clock) return null;
    return clock.lastReactionAt !== null && clock.lastReactionAt > clock.createdAt
      ? clock.lastReactionAt
      : clock.createdAt;
  }

  /**
   * Auto-pause: a `self_started` initiative whose owner has not reacted for AUTO_PAUSE_DAYS is
   * paused (ledger only, like config-service `load`; its file keeps `state: self_started` until
   * the owner resumes it). The clock is `last_reaction_at`, which only `recordDecision` writes,
   * falling back to the creation time. An automatic start does not write a decision row
   * (autonomy.ts), so the runner's own activity can never keep an initiative alive.
   * Pinned by `__tests__/self-start.test.ts` ('auto-pause after 14 days').
   */
  function idleReason(row: InitiativeRow): string | null {
    if (row.state !== 'self_started') return null;
    const since = idleSince(row.id);
    if (since === null) return null;
    const idleMs = deps.now().getTime() - Date.parse(since);
    return idleMs >= AUTO_PAUSE_DAYS * DAY_MS
      ? `auto-paused: no reaction in ${AUTO_PAUSE_DAYS} days`
      : null;
  }

  function pauseIdle(): string[] {
    const paused: string[] = [];
    for (const row of agentRows()) {
      const why = idleReason(row);
      if (why === null) continue;
      store.transitionInitiative(row.id, 'paused', why);
      paused.push(row.id);
    }
    return paused;
  }

  /** Pauses `id` when it is idle; returns the reason so a run can refuse with it. */
  function pauseIfIdle(id: string): string | null {
    const row = store.getInitiative(id);
    const why = row ? idleReason(row) : null;
    if (why !== null) store.transitionInitiative(id, 'paused', why);
    return why;
  }

  /** A stopped initiative of the same personality that this draft repeats, by id or by title. */
  async function stoppedMatch(
    personalityId: string,
    id: string | undefined,
    title: string,
  ): Promise<string | null> {
    for (const row of store.list({ personalityId, states: ['stopped'] })) {
      let same = id !== undefined && row.id === id;
      if (!same) {
        try {
          const loaded = await deps.load(row.id);
          same = loaded !== null && normalise(loaded.file.title) === normalise(title);
        } catch (err) {
          deps.onError?.(err);
        }
      }
      if (!same) continue;
      const why = store.reactionClock(row.id)?.stopReason;
      return `matches the stopped initiative "${row.id}"${why ? ` (stopped: ${why})` : ''}`;
    }
    return null;
  }

  /**
   * Turns a draft's YAML into the file the config service validates. The agent proposes only a
   * subset; what it leaves out it inherits from its parent, which can only narrow (the service
   * refuses anything wider: R6). Its own `guidance` becomes `notes`, labelled as its own, so it
   * never reads as the owner's guidance (R8). The budget is clamped to what the pool has left.
   */
  function buildDraft(
    raw: Record_,
    parent: InitiativeFile,
    draft: DraftRow,
    allocatable: number,
  ): Record_ {
    const title = typeof raw.title === 'string' ? raw.title : '';
    const asked =
      isRecord(raw.budget) && typeof raw.budget.usd_per_day === 'number'
        ? raw.budget.usd_per_day
        : allocatable;
    const own = (Array.isArray(raw.guidance) ? raw.guidance : [])
      .map(guidanceText)
      .filter((t): t is string => t !== null);
    const notes = [
      ...(Array.isArray(raw.notes) ? raw.notes : []).filter(
        (n): n is string => typeof n === 'string',
      ),
      ...own,
      `why: ${draft.why}`,
    ].map((n) => (n.startsWith('agent: ') ? n : `agent: ${n}`));
    return {
      ...raw,
      id: typeof raw.id === 'string' ? raw.id : slug(title),
      version: 1,
      origin: 'agent',
      created_in: 'scan',
      state: 'self_started',
      parent_id: draft.parentId,
      exclude: raw.exclude ?? parent.exclude,
      autonomy: raw.autonomy ?? parent.autonomy,
      timeline: raw.timeline ?? parent.timeline,
      delivery: raw.delivery ?? parent.delivery,
      budget: {
        usd_per_exploration: parent.budget.usd_per_exploration,
        max_open_explorations: Math.min(parent.budget.max_open_explorations, 2),
        ...(isRecord(raw.budget) ? raw.budget : {}),
        usd_per_day: Math.min(asked, allocatable, parent.budget.usd_per_day),
      },
      guidance: [],
      notes,
    };
  }

  async function settle(d: DraftRow, out: DraftOutcome): Promise<DraftOutcome> {
    if (out.status !== 'suggested') {
      store.settleDraft(d.id, out.status, out.status === 'refused' ? out.reason : null);
    }
    return out;
  }

  /**
   * After a run ends, turns each pending draft into an agent-origin initiative through
   * `InitiativeConfigService.save` (origin agent, confirmedBy 'runner'), or leaves it be:
   * - self-start off for the parent's personality: the draft stays `pending` and is a
   *   suggestion in the digest. No file is written.
   * - refused: a stopped topic, an agent parent, a pool with nothing left, or anything the
   *   service refuses (max count, widening, sources, guidance). `refusal` keeps the reason.
   * Limitation: a stopped topic is matched by id or by identical normalised title; a reworded
   * title is not caught.
   */
  async function materialiseDrafts(): Promise<DraftOutcome[]> {
    const outcomes: DraftOutcome[] = [];
    for (const d of store.drafts('pending')) {
      const out = (o: Omit<DraftOutcome, 'draftId'>) => settle(d, { draftId: d.id, ...o });
      const parentRow = store.getInitiative(d.parentId);
      if (!parentRow) {
        outcomes.push(await out({ status: 'refused', reason: `parent "${d.parentId}" not found` }));
        continue;
      }
      const settings = await deps.settings(parentRow.personalityId);
      if (!settings.selfStart) {
        outcomes.push(
          await out({ status: 'suggested', reason: 'self-start is off; shown to the owner' }),
        );
        continue;
      }
      if (parentRow.origin === 'agent') {
        outcomes.push(
          await out({ status: 'refused', reason: 'an agent initiative cannot start another' }),
        );
        continue;
      }
      let raw: unknown;
      try {
        raw = parse(d.draftYaml);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        outcomes.push(await out({ status: 'refused', reason: `draft is not valid YAML: ${why}` }));
        continue;
      }
      if (!isRecord(raw)) {
        outcomes.push(await out({ status: 'refused', reason: 'draft must be a mapping' }));
        continue;
      }
      const title = typeof raw.title === 'string' ? raw.title : '';
      const repeat = await stoppedMatch(
        parentRow.personalityId,
        typeof raw.id === 'string' ? raw.id : undefined,
        title,
      );
      if (repeat !== null) {
        outcomes.push(await out({ status: 'refused', reason: repeat }));
        continue;
      }
      const allocatable = await allocatableUsd();
      if (allocatable + 1e-9 < MIN_SELF_START_USD) {
        outcomes.push(
          await out({
            status: 'refused',
            reason: `the self-start pool has $${allocatable.toFixed(2)} left; a new initiative needs $${MIN_SELF_START_USD.toFixed(2)}`,
          }),
        );
        continue;
      }
      let parent: { file: InitiativeFile } | null = null;
      try {
        parent = await deps.load(d.parentId);
      } catch (err) {
        deps.onError?.(err);
      }
      if (!parent) {
        outcomes.push(
          await out({ status: 'refused', reason: `parent "${d.parentId}" cannot be loaded` }),
        );
        continue;
      }
      const result = await deps.config.save({
        personalityId: parentRow.personalityId,
        op: 'create',
        draft: buildDraft(raw, parent.file, d, allocatable),
        sessionId: `runner:${d.parentId}`,
        confirmedBy: 'runner',
      });
      outcomes.push(
        await out(
          result.ok
            ? { status: 'materialised', reason: null, initiativeId: result.id }
            : { status: 'refused', reason: result.error },
        ),
      );
    }
    return outcomes;
  }

  return {
    materialiseDrafts,
    pauseIdle,
    pauseIfIdle,
    allocatableUsd,
    poolRemainingTodayUsd,
  };
}

export type SelfStart = ReturnType<typeof createSelfStart>;
