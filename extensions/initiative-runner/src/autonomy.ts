import type { ExplorationRow, InitiativeStore } from '@ethosagent/types';
import type { InitiativeFile } from './config-schema';

/** Share of `usd_per_day` a stalled exploration may spend on its partial brief (budget.ts `briefReserveShare`). */
export const BRIEF_RESERVE_SHARE = 0.15;

export interface AutonomyVerdict {
  start: boolean;
  reason: string;
}

/**
 * Gate 1 under the initiative's autonomy. `ask` always waits; `free` starts; `free_under`
 * starts when the estimate is at most `ask_above_usd` and waits above it. An absent
 * `ask_above_usd` is unbounded (the same reading `widening` in config-service.ts uses), and an
 * unknown estimate always waits: a cost nobody stated is not a cost under the limit.
 */
export function decideAutonomy(
  autonomy: InitiativeFile['autonomy'],
  estimateUsd: number | null,
): AutonomyVerdict {
  if (autonomy.mode === 'ask') return { start: false, reason: 'autonomy is ask' };
  if (autonomy.mode === 'free') return { start: true, reason: 'autonomy is free' };
  const limit = autonomy.ask_above_usd ?? Number.POSITIVE_INFINITY;
  if (estimateUsd === null) {
    return { start: false, reason: 'no estimate to compare with the limit' };
  }
  return estimateUsd > limit
    ? { start: false, reason: `estimate $${estimateUsd.toFixed(2)} is above $${limit.toFixed(2)}` }
    : { start: true, reason: `estimate $${estimateUsd.toFixed(2)} is within $${limit.toFixed(2)}` };
}

export interface AutonomyOutcome {
  started: Array<{ explorationId: string; reason: string }>;
  waiting: Array<{ explorationId: string; reason: string }>;
}

type AutonomyStore = Pick<InitiativeStore, 'explorations' | 'transitionExploration'>;

/**
 * Applies `decideAutonomy` to freshly proposed explorations: a start is the transition
 * proposed -> exploring, nothing more.
 *
 * Decision rows are written only by approval surfaces (`recordDecision`), and an automatic start
 * is not one. A row from here would also count in the gate-1 approval rate (computeGateMetrics)
 * and bump `last_reaction_at`, which would keep a self-started initiative from ever auto-pausing.
 * The reason lives in the run report and the digest instead. A start also needs a free slot
 * under `max_open_explorations`; without one the proposal waits for the owner.
 */
export function applyAutonomy(
  store: AutonomyStore,
  file: InitiativeFile,
  proposals: readonly ExplorationRow[],
): AutonomyOutcome {
  const out: AutonomyOutcome = { started: [], waiting: [] };
  let running = store.explorations(file.id, ['exploring', 'stalled']).length;
  for (const p of proposals) {
    if (p.state !== 'proposed') continue;
    const verdict = decideAutonomy(file.autonomy, p.estimateUsd);
    if (!verdict.start) {
      out.waiting.push({ explorationId: p.id, reason: verdict.reason });
      continue;
    }
    if (running >= file.budget.max_open_explorations) {
      out.waiting.push({
        explorationId: p.id,
        reason: `${verdict.reason}, but ${running} already running (max_open_explorations ${file.budget.max_open_explorations})`,
      });
      continue;
    }
    store.transitionExploration(p.id, 'exploring', `auto-started: ${verdict.reason}`);
    running++;
    out.started.push({ explorationId: p.id, reason: verdict.reason });
  }
  return out;
}

type WindowStore = Pick<InitiativeStore, 'get' | 'transitionExploration' | 'extendExploration'>;

export interface PreparedWindow {
  exploration: ExplorationRow;
  /** `brief` when the exploration is stalled: the window only hands in a partial brief. */
  kind: 'window' | 'brief';
  /** True when a "dig deeper" had reopened an exhausted exploration and it was given a new budget. */
  reopened: boolean;
}

const DAY_MS = 86_400_000;

function spent(e: ExplorationRow, now: Date, reserveUsd: number): 'budget' | 'days' | null {
  if (e.budgetUsd - e.spentUsd < reserveUsd) return 'budget';
  return now.getTime() >= Date.parse(e.deadline) ? 'days' : null;
}

/**
 * What to do with an exploration before its window runs.
 * - stalled: a brief window (partial brief), never a silent stop.
 * - exploring but out of budget or days: with a brief on the ledger, the owner reopened it with
 *   "dig deeper" (the only way briefed -> exploring), so it gets a fresh budget
 *   (`usd_per_exploration`) and deadline (`default_days`); without one it stalled unnoticed, so
 *   it moves to stalled and hands in a partial brief.
 */
export function prepareWindow(
  store: WindowStore,
  file: InitiativeFile,
  exploration: ExplorationRow,
  now: Date,
  reserveUsd: number,
): PreparedWindow {
  if (exploration.state === 'stalled') return { exploration, kind: 'brief', reopened: false };
  if (!spent(exploration, now, reserveUsd)) {
    return { exploration, kind: 'window', reopened: false };
  }
  const briefed = (store.get(file.id)?.briefs ?? []).some(
    (b) => b.explorationId === exploration.id,
  );
  if (briefed && file.budget.usd_per_exploration > 0) {
    const fresh = store.extendExploration(exploration.id, {
      addBudgetUsd: file.budget.usd_per_exploration,
      deadline: new Date(now.getTime() + file.timeline.default_days * DAY_MS).toISOString(),
    });
    return { exploration: fresh, kind: 'window', reopened: true };
  }
  store.transitionExploration(exploration.id, 'stalled', 'budget or days used');
  return { exploration: { ...exploration, state: 'stalled' }, kind: 'brief', reopened: false };
}

export type WindowOutcome = 'briefed' | 'stalled' | 'exploring';

/**
 * After a window: a new brief moves the exploration to briefed (from exploring or stalled);
 * otherwise an exploration that used its budget or days stalls, so the next window hands in a
 * partial brief. A day-cap stop does not stall it: that is the day's limit, not the exploration's.
 */
export function settleWindow(
  store: Pick<InitiativeStore, 'getExploration' | 'transitionExploration'>,
  explorationId: string,
  briefSubmitted: boolean,
  now: Date,
  reserveUsd: number,
): WindowOutcome {
  const e = store.getExploration(explorationId);
  if (!e) return 'exploring';
  if (briefSubmitted && (e.state === 'exploring' || e.state === 'stalled')) {
    store.transitionExploration(explorationId, 'briefed', 'brief submitted');
    return 'briefed';
  }
  if (e.state === 'exploring' && spent(e, now, reserveUsd)) {
    store.transitionExploration(explorationId, 'stalled', 'budget or days used');
    return 'stalled';
  }
  return e.state === 'stalled' ? 'stalled' : 'exploring';
}
