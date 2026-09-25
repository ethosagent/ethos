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
// Per personality (plan decision-provider-personality §7.2, PD6): core passes
// the turn's `personalityId` on the classifier input (`result-defense.ts`);
// this classifier looks it up in the build's personality registry — the same
// instance the loop resolves turns from (`infra.personalities`,
// build-agent-loop.ts) — and resolves the mode with
// `resolvePersonalityDecisionSite` (@ethosagent/config) per call. A missing
// id, an unknown personality, or a site that resolves `off` calls
// `fallback({ content })` — exactly today's classifier call — without
// touching the provider handle. Known limitation (plan K4): a registry refresh
// between two tool results of one turn can change the mode mid-turn; either
// mode is a legal state for that personality.

import { type ResolvedDecisionsConfig, resolvePersonalityDecisionSite } from '@ethosagent/config';
import type {
  DecisionAnswer,
  InjectionClassifier,
  InjectionVerdict,
  PersonalityRegistry,
} from '@ethosagent/types';
import type { DecisionProviderHandle } from './decision-provider';
import { DECISION_QUESTION_IDS, INJECTION_QUESTIONS } from './decision-questions';
import {
  type DecisionRecordTracker,
  type DecisionSiteRecorder,
  meetsThreshold,
  runDecisionSite,
} from './decision-site';

/** The single question id this site asks. */
export const INJECTION_QUESTION_ID = DECISION_QUESTION_IDS.injection;

export interface CreateDecisionInjectionClassifierOptions {
  /** The ONE provider handle of the composition root (shared breaker, §5.5), read lazily. */
  provider: DecisionProviderHandle;
  /** Today's path: the LLM classifier (which falls back to the pattern check). */
  fallback: InjectionClassifier;
  /** The operator's resolved `decisions.*`: threshold (T_injection), budget (R9). */
  global: ResolvedDecisionsConfig;
  /** The registry the loop resolves turns from; `personalityId` is looked up here. */
  personalities: Pick<PersonalityRegistry, 'get'>;
  observability?: DecisionSiteRecorder;
  /** The build's shadow-record tracker, drained at dispose (R8). */
  tracker?: DecisionRecordTracker;
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
  const threshold = opts.global.thresholds.injection;
  return async ({ content, personalityId }) => {
    const personality =
      personalityId !== undefined ? opts.personalities.get(personalityId) : undefined;
    const site = resolvePersonalityDecisionSite(personality?.decisions, 'injection', opts.global);
    if (!personality || site.effective === 'off') return opts.fallback({ content });
    return runDecisionSite<InjectionVerdict, boolean>({
      site: 'injection',
      mode: site.effective,
      provider: await opts.provider.get(),
      digest: { kind: 'text', value: content },
      questions: INJECTION_QUESTIONS,
      timeoutMs: site.timeoutMs,
      personalityId: personality.id,
      gate: (answers) => injectionVerdictFrom(answers, threshold),
      // Pre-threshold reading for shadow disagreement (plan §8): p ≥ 0.5.
      interpret: (answers) => {
        const a = booleanAnswer(answers);
        return a ? a.p >= 0.5 : null;
      },
      disagrees: (jev, today) => jev !== today.containsInstructions,
      today: () => opts.fallback({ content }),
      ...(opts.observability ? { recorder: opts.observability } : {}),
      ...(opts.tracker ? { tracker: opts.tracker } : {}),
    });
  };
}
