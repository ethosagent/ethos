import type { InitiativeStore } from '@ethosagent/types';
import type { InitiativeFile } from './config-schema';

const DAY_MS = 86_400_000;

/**
 * The owner's "dig deeper" on a briefed exploration: records the decision (gate 2, which moves
 * briefed -> exploring) and then gives it a fresh budget (`usd_per_exploration`) and deadline
 * (`default_days`). An approval surface calls this; the runner never does, so a run cannot
 * reopen its own work. Pinned by autonomy.test.ts ('dig deeper reopens with a new budget').
 */
export function digDeeper(
  store: Pick<InitiativeStore, 'recordDecision' | 'extendExploration'>,
  file: Pick<InitiativeFile, 'budget' | 'timeline'>,
  input: { explorationId: string; decidedBy: string; reason?: string; now: Date },
) {
  store.recordDecision({
    target: input.explorationId,
    gate: 'gate2_adopt',
    verdict: 'dig_deeper',
    reason: input.reason ?? null,
    option: null,
    decidedBy: input.decidedBy,
  });
  return store.extendExploration(input.explorationId, {
    addBudgetUsd: file.budget.usd_per_exploration,
    deadline: new Date(input.now.getTime() + file.timeline.default_days * DAY_MS).toISOString(),
  });
}
