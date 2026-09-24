// The tier router over a decision provider (plan/phases/decision-provider-jev.md
// §8.3, D15, R1, R9). Builds the `TierRouter` core calls at turn setup
// (`routeTurnTier`, packages/core/src/agent-loop/tier-router.ts), which owns
// WHEN it is called: never on a user override, and only when `trivial` and
// `default` resolve to different models this turn (R1).
//
// Downgrade-only (D15), enforced twice: `routerVerdictFrom` below maps only a
// `trivial` answer at `confidence ≥ T_trivial` to a verdict, and core ignores
// any router answer that is not exactly `'trivial'`. `ROUTER_QUESTIONS`
// (./decision-questions, the one owner — calibration measures the same
// question) offers `trivial` / `default` only.
//
// Mode, redaction of the user message (`redactString`, R2), the calibrated
// check, shadow (R8: today's `null` returns at once; Jev's reading is recorded
// when it settles) and the per-call record carrying `latencyMs` (D13 — the
// router's latency per turn) all live in `runDecisionSite` (./decision-site).
// Today's path is "no routing". The call runs on the router's own budget,
// `decisions.timeouts.router` (default 500 ms, R9), which is below the
// provider's `decisions.timeoutMs` yardstick, so a router timeout never counts
// toward the breaker (`budget >= defaultTimeoutMs`,
// extensions/decision-typesafe/src/provider.ts).
//
// Tier 1, NOT in `kernel_paths`: the router moves a turn between two models an
// operator already configured for the personality; it guards no published
// guarantee in docs/content/security/security-boundary.md, and the rule that
// it can only move DOWN is held in core as well as here.
//
// Pinned by `__tests__/decision-router.test.ts`.

import type { DecisionSiteMode } from '@ethosagent/config';
import type { TierRouter } from '@ethosagent/core';
import type { DecisionAnswer, DecisionProvider } from '@ethosagent/types';
import {
  DECISION_QUESTION_IDS,
  ROUTER_CHOICES,
  ROUTER_QUESTIONS,
  type RouterChoice,
} from './decision-questions';
import { type DecisionSiteRecorder, meetsThreshold, runDecisionSite } from './decision-site';

/** The single question id this site asks. */
export const ROUTER_QUESTION_ID = DECISION_QUESTION_IDS.router;

export interface CreateDecisionTierRouterOptions {
  /** The ONE provider instance of the composition root (shared breaker, §5.5). */
  decisions: DecisionProvider | undefined;
  /** `decisions.sites.router`, EFFECTIVE (R6: `on` without a threshold is `shadow`). */
  mode: DecisionSiteMode;
  /** `decisions.thresholds.router` (T_trivial). */
  threshold: number | undefined;
  /** `decisions.timeouts.router` resolved (R9, default 500). */
  timeoutMs: number;
  recorder?: DecisionSiteRecorder;
}

function isRouterChoice(choice: string): choice is RouterChoice {
  return ROUTER_CHOICES.some((c) => c === choice);
}

/** The answer to this site's question, or `null` for a missing / off-list one. */
function routerChoice(
  answers: Record<string, DecisionAnswer>,
): { choice: RouterChoice; confidence: number } | null {
  const a = answers[ROUTER_QUESTION_ID];
  if (a?.type !== 'choice' || !isRouterChoice(a.choice)) return null;
  return { choice: a.choice, confidence: a.confidence };
}

/**
 * §8.3: `trivial` only when the choice is `trivial` at `confidence ≥
 * T_trivial`. Anything else — a `default` answer, a low confidence, a missing
 * threshold (`meetsThreshold` fails closed) — is `null`: no routing.
 */
export function routerVerdictFrom(
  answers: Record<string, DecisionAnswer>,
  threshold: number | undefined,
): 'trivial' | null {
  const a = routerChoice(answers);
  if (a?.choice !== 'trivial') return null;
  return meetsThreshold(a.confidence, threshold) ? 'trivial' : null;
}

export function createDecisionTierRouter(opts: CreateDecisionTierRouterOptions): TierRouter {
  // Today's path is `null`, so every outcome but an acted-on `trivial` is
  // "no routing".
  return ({ message, signal }) =>
    runDecisionSite<'trivial' | null, RouterChoice>({
      site: 'router',
      mode: opts.mode,
      provider: opts.decisions,
      digest: { kind: 'text', value: message },
      questions: ROUTER_QUESTIONS,
      timeoutMs: opts.timeoutMs,
      ...(signal ? { signal } : {}),
      gate: (answers) => routerVerdictFrom(answers, opts.threshold),
      // Shadow reading (plan §8): the argmax choice, before any threshold.
      interpret: (answers) => routerChoice(answers)?.choice ?? null,
      disagrees: (jev, today) => jev !== (today ?? 'default'),
      today: async () => null,
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
    });
}
