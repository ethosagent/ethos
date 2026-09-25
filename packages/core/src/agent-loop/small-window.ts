// Per-personality small-window mode.
//
// Small-window mode used to be ONE loop-level decision, made at construction
// from the startup personality's static prefix. A loop serves many
// personalities (a `/personality` switch, a web or gateway turn for another
// personality), each with its own SOUL, toolset and `fs_reach` workdir, and
// the workdir decides which AGENTS.md/CLAUDE.md the prompt carries. So the
// decision is a per-turn question with a per-personality answer.
//
// Wiring answers it (`createSmallWindowResolver`,
// packages/wiring/src/small-window-resolver.ts): it measures the personality's
// real static prefix and memoizes the verdict, so the answer is constant while
// the inputs are, and the prompt prefix stays byte-stable across turns. Core
// only applies the answer. No resolver → the loop-level `options.smallWindow`
// / `promptBudget` / `historyLimit` apply to every turn, exactly as before.

import type { PersonalityConfig } from '@ethosagent/types';
import type { LoopDeps } from './turn-context';

/** What small-window mode changes for a turn when it engages. */
export interface SmallWindowOverlay {
  /** Replaces the loop's `promptBudget` for the turn (compact prelude, index memory/skills). */
  promptBudget?: LoopDeps['promptBudget'];
  /** Replaces the loop's `historyLimit` for the turn. */
  historyLimit?: number;
}

/**
 * Decide small-window mode for one turn: the overlay when the mode engages
 * for this personality in this working directory, `undefined` when it does
 * not. Called once per turn by `setupTurn` (stages/turn-setup.ts), with the
 * workdir that turn resolved from the personality's `fs_reach`.
 */
export type SmallWindowResolver = (
  personality: PersonalityConfig,
  workingDir: string,
) => Promise<SmallWindowOverlay | undefined>;

/**
 * The loop deps one turn runs with: the loop's own when no overlay engaged,
 * otherwise with small-window mode on and the overlay's budget and history
 * limit. Used by `AgentLoop.run` for context assembly, the overflow retry and
 * the turn-end maintenance, so all three see the turn's decision.
 */
export function withSmallWindow(deps: LoopDeps, overlay: SmallWindowOverlay | undefined): LoopDeps {
  if (!overlay) return deps;
  return {
    ...deps,
    smallWindow: true,
    ...(overlay.promptBudget ? { promptBudget: overlay.promptBudget } : {}),
    ...(overlay.historyLimit !== undefined ? { historyLimit: overlay.historyLimit } : {}),
  };
}
