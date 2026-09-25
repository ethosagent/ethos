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
// / `promptBudget` / `historyLimit` / `resultBudgetChars` apply to every turn,
// exactly as before.
//
// The same measurement sizes the window-scaled tool-result budget
// (`resolveResultBudgetGate`, packages/wiring/src/static-floor.ts), which
// depends on that personality's static floor, so the overlay carries it too.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PersonalityConfig } from '@ethosagent/types';
import { deriveFsReachPaths } from '../fs-reach';
import type { LoopDeps } from './turn-context';

/** The per-personality window decisions for one turn. */
export interface SmallWindowOverlay {
  /** Whether small-window mode is on for the turn (gates the declared
   *  `small_window_toolset` narrowing in `setupTurn`). */
  smallWindow: boolean;
  /** Replaces the loop's `promptBudget` for the turn (compact prelude, index memory/skills). */
  promptBudget?: LoopDeps['promptBudget'];
  /** Replaces the loop's `historyLimit` for the turn. */
  historyLimit?: number;
  /** Replaces the loop's per-turn tool-result budget for the turn. */
  resultBudgetChars?: number;
  /** The compaction gate's largest-single-result reserve derived from
   *  `resultBudgetChars`. Read only when `resultBudgetChars` is set; absent
   *  then means NO reserve for this personality, even if the loop has one. */
  maxSingleToolResultTokens?: number;
}

/**
 * Decide the window overlay for one turn; `undefined` keeps the loop's own
 * options. Called once per turn by `setupTurn` (stages/turn-setup.ts) with the
 * workdir that turn resolved from the personality's `fs_reach`, and by a
 * manual `/compact` through `historyLimitFor` below.
 */
export type SmallWindowResolver = (
  personality: PersonalityConfig,
  workingDir: string,
) => Promise<SmallWindowOverlay | undefined>;

/**
 * The loop deps one turn runs with: the loop's own when there is no overlay,
 * otherwise with the overlay's small-window flag, prompt budget, history limit
 * and tool-result budget. `AgentLoop.run` uses it for context assembly, tool
 * processing, the overflow retry and the turn-end maintenance, so all of them
 * see the turn's decision. Pinned by
 * packages/wiring/src/__tests__/small-window-resolver.test.ts.
 */
export function withSmallWindow(deps: LoopDeps, overlay: SmallWindowOverlay | undefined): LoopDeps {
  if (!overlay) return deps;
  const next: LoopDeps = { ...deps, smallWindow: overlay.smallWindow };
  if (overlay.promptBudget) next.promptBudget = overlay.promptBudget;
  if (overlay.historyLimit !== undefined) next.historyLimit = overlay.historyLimit;
  if (overlay.resultBudgetChars !== undefined) {
    next.resultBudgetChars = overlay.resultBudgetChars;
    const { maxSingleToolResultTokens: _loopReserve, ...compaction } = deps.compaction ?? {};
    if (overlay.maxSingleToolResultTokens !== undefined) {
      next.compaction = {
        ...compaction,
        maxSingleToolResultTokens: overlay.maxSingleToolResultTokens,
      };
    } else if (deps.compaction) {
      next.compaction = compaction;
    }
  }
  return next;
}

/**
 * The history limit a manual `/compact` reads for `personality`: the one its
 * turns run with (`withSmallWindow`), so a small-window personality compacts
 * over the same scaled history its turns see. `undefined` when no resolver is
 * wired; `compactSession` (manual-compact.ts) then uses the loop's limit, as
 * before. An unusable `fs_reach` (which a turn refuses) keeps the loop's limit.
 */
export function historyLimitFor(
  deps: Pick<LoopDeps, 'smallWindowResolver' | 'historyLimit' | 'dataDir' | 'workingDir'>,
): ((personality: PersonalityConfig) => Promise<number>) | undefined {
  const resolver = deps.smallWindowResolver;
  if (!resolver) return undefined;
  return async (personality) => {
    let workdir: string;
    try {
      workdir = deriveFsReachPaths(personality, {
        ethosHome: deps.dataDir ?? join(homedir(), '.ethos'),
        self: personality.id,
        cwd: deps.workingDir,
      }).workdir;
    } catch {
      return deps.historyLimit;
    }
    return (await resolver(personality, workdir))?.historyLimit ?? deps.historyLimit;
  };
}
