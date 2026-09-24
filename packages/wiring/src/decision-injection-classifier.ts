// The injection classifier over a decision provider (plan
// plan/phases/decision-provider-jev.md §8.1, D16). Tier 0 beside
// `smart-approver.ts`: it composes the verdict that reaches
// `packages/core/src/agent-loop/result-defense.ts`, so it is listed in
// `@ethosagent/wiring`'s `kernel_paths` in `.architecture-state.yaml`.
//
// Authority bound (Law 11): whatever this returns can only ADD an injection
// flag. `result-defense.ts` composes `tier1Hit || verdict.containsInstructions`,
// so no classifier — LLM or decision provider — can clear a Tier-1 hit.
//
// The fallback chain is decision provider → `fallback` (the LLM classifier,
// `createLLMClassifier`) → the pattern check, which `createLLMClassifier`
// itself falls back to on any failure (packages/safety/injection/src/classifier.ts).
// Mode, redaction, the threshold rule and shadow live in `runDecisionSite`
// (./decision-site); this file supplies only the digest, the D16 mapping and
// the question, which it imports from ./decision-questions (the one owner).
// Pinned by `__tests__/decision-injection-classifier.test.ts`.
//
// M2 switches the provider-interface import to `@ethosagent/types`; nothing
// else here changes.

import type { DecisionSiteMode } from '@ethosagent/config';
import type {
  DecisionAnswer,
  DecisionProvider,
  InjectionClassifier,
  InjectionVerdict,
} from '@ethosagent/types';
import { DECISION_QUESTION_IDS, INJECTION_QUESTIONS } from './decision-questions';
import { type DecisionSiteRecorder, meetsThreshold, runDecisionSite } from './decision-site';

/** The single question id this site asks. */
export const INJECTION_QUESTION_ID = DECISION_QUESTION_IDS.injection;

export interface CreateDecisionInjectionClassifierOptions {
  decisions: DecisionProvider | undefined;
  /** Today's path: the LLM classifier (which falls back to the pattern check). */
  fallback: InjectionClassifier;
  /** The injection site's EFFECTIVE mode (R6). */
  mode: DecisionSiteMode;
  /** `decisions.thresholds.injection` (T_injection). */
  threshold: number | undefined;
  /** `decisions.timeouts.injection` resolved (R9). */
  timeoutMs: number;
  observability?: DecisionSiteRecorder;
}

function booleanAnswer(answers: Record<string, DecisionAnswer>) {
  const a = answers[INJECTION_QUESTION_ID];
  return a?.type === 'boolean' ? a : null;
}

/**
 * D16: at `confidence ≥ T_injection`, `containsInstructions = p ≥ 0.5`, the
 * verdict's confidence is its confidence IN THAT VERDICT (`p` or `1 − p`),
 * `source: 'llm'`, no `reason` (the provider writes no text). Otherwise `null`
 * — today's path runs.
 */
export function injectionVerdictFrom(
  answers: Record<string, DecisionAnswer>,
  threshold: number | undefined,
): InjectionVerdict | null {
  const a = booleanAnswer(answers);
  if (!a || !meetsThreshold(a.confidence, threshold)) return null;
  const containsInstructions = a.p >= 0.5;
  return {
    containsInstructions,
    confidence: containsInstructions ? a.p : 1 - a.p,
    source: 'llm',
  };
}

export function createDecisionInjectionClassifier(
  opts: CreateDecisionInjectionClassifierOptions,
): InjectionClassifier {
  return ({ content }) =>
    runDecisionSite<InjectionVerdict, boolean>({
      site: 'injection',
      mode: opts.mode,
      provider: opts.decisions,
      digest: { kind: 'text', value: content },
      questions: INJECTION_QUESTIONS,
      timeoutMs: opts.timeoutMs,
      gate: (answers) => injectionVerdictFrom(answers, opts.threshold),
      // Pre-threshold reading for shadow disagreement (plan §8): p ≥ 0.5.
      interpret: (answers) => {
        const a = booleanAnswer(answers);
        return a ? a.p >= 0.5 : null;
      },
      disagrees: (jev, today) => jev !== today.containsInstructions,
      today: () => opts.fallback({ content }),
      ...(opts.observability ? { recorder: opts.observability } : {}),
    });
}
