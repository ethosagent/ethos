import { RUNNER_TEAL, type RunnerAccent } from './runners';

// The decision accent — the CSS half of decision-provider identity (plan
// decision-provider-personality §15.1; DESIGN.md "Decision accent"). The
// identity map itself (`resolveDecisionProvider`) is pure data the trail
// reducer reads, so it lives in `@ethosagent/chat-state`
// (packages/chat-state/src/decision-providers.ts) beside that reducer.

/**
 * DESIGN.md's `decision` token: the runner-teal values (the hex lives only in
 * `lib/runners.ts`). It is not an `--accent` — the personality's hue stays the
 * personality's. Stamped once on `:root` as `--decision` by `main.tsx`, per skin.
 */
export const DECISION_ACCENT: RunnerAccent = RUNNER_TEAL;

export function decisionAccentCss(light: boolean): string {
  return light ? DECISION_ACCENT.light : DECISION_ACCENT.dark;
}
