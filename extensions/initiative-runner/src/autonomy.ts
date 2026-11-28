import {
  type BriefRow,
  EthosError,
  type ExplorationRow,
  type FindingRow,
  type InitiativeStore,
} from '@ethosagent/types';
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

type WindowStore = Pick<InitiativeStore, 'transitionExploration'>;

export interface PreparedWindow {
  exploration: ExplorationRow;
  /** `brief` when the exploration is stalled: the window only hands in a partial brief. */
  kind: 'window' | 'brief';
}

function spent(e: ExplorationRow, now: Date, reserveUsd: number): 'budget' | 'days' | null {
  if (e.budgetUsd - e.spentUsd < reserveUsd) return 'budget';
  return now.getTime() >= Date.parse(e.deadline) ? 'days' : null;
}

/**
 * What to do with an exploration before its window runs.
 * - stalled: a brief window (the one window of this stall), never a silent stop.
 * - exploring but out of budget or days: it stalls and hands in a partial brief.
 *
 * The runner never extends an exploration on its own. A "dig deeper" is an owner decision:
 * `digDeeper` (dig-deeper.ts) records it and extends the budget before any window runs, so an
 * extended exploration arrives here with money left. A brief on the ledger proves nothing about
 * the owner's choice and is not read as one.
 */
export function prepareWindow(
  store: WindowStore,
  exploration: ExplorationRow,
  now: Date,
  reserveUsd: number,
): PreparedWindow {
  if (exploration.state === 'stalled') return { exploration, kind: 'brief' };
  if (!spent(exploration, now, reserveUsd)) return { exploration, kind: 'window' };
  store.transitionExploration(exploration.id, 'stalled', 'budget or days used');
  return { exploration: { ...exploration, state: 'stalled' }, kind: 'brief' };
}

export type WindowOutcome = 'briefed' | 'stalled' | 'exploring';

/** The partial brief the runner hands in itself when a brief window ended without one. */
export function partialBrief(
  e: ExplorationRow,
  findings: readonly FindingRow[],
): Omit<BriefRow, 'id' | 'version'> {
  const evidence = findings.map((f) => `- ${f.id} (${f.confidence}): ${f.claim} [${f.sourceRef}]`);
  const money = `${e.spentUsd.toFixed(2)} of ${e.budgetUsd.toFixed(2)} USD spent.`;
  return {
    explorationId: e.id,
    bodyMd: [
      '## Options',
      '- The window ended before the question was answered; no options were weighed.',
      '',
      '## Evidence',
      ...(evidence.length > 0 ? evidence : ['- No findings were recorded.']),
      '',
      '## Cost',
      money,
      '',
      '## Risk',
      'Partial: the evidence above is all there is. Written by the runner, not the agent.',
      '',
      '## Recommendation',
      'Dig deeper or park; the question is not answered.',
    ].join('\n'),
    recommendedOption: 'dig deeper or park',
    partial: true,
  };
}

/**
 * After a window: a brief moves the exploration to briefed (from exploring or stalled);
 * otherwise an exploration that used its budget or days stalls, so its one brief window runs
 * next. A day-cap stop does not stall it: that is the day's limit, not the exploration's.
 *
 * A stalled exploration's brief must be partial: it stopped for want of budget or days, so a
 * brief that claims completeness is refused here (throws, nothing moves). The runner always
 * hands in its own partial brief first (`partialBrief`), so this holds as an assertion.
 */
export function settleWindow(
  store: Pick<InitiativeStore, 'getExploration' | 'transitionExploration'>,
  explorationId: string,
  briefs: readonly Pick<BriefRow, 'partial'>[],
  now: Date,
  reserveUsd: number,
): WindowOutcome {
  const e = store.getExploration(explorationId);
  if (!e) return 'exploring';
  if (briefs.length > 0 && (e.state === 'exploring' || e.state === 'stalled')) {
    if (e.state === 'stalled' && !briefs.some((b) => b.partial)) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `exploration "${explorationId}" is stalled but its brief is not partial`,
        action: 'A stalled exploration hands in a partial brief (partial: true).',
      });
    }
    store.transitionExploration(explorationId, 'briefed', 'brief submitted');
    return 'briefed';
  }
  if (e.state === 'exploring' && spent(e, now, reserveUsd)) {
    store.transitionExploration(explorationId, 'stalled', 'budget or days used');
    return 'stalled';
  }
  return e.state === 'stalled' ? 'stalled' : 'exploring';
}
