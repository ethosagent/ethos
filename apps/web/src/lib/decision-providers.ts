import { RUNNER_TEAL, type RunnerAccent } from './runners';

// Decision-provider identity — data, not CSS (plan decision-provider-personality
// §15.1; DESIGN.md "Decision accent").
//
// A decision row in the trail names the model that decided with a label (`Jev`,
// used in copy) and a short mono tag (`jev`). Every chat surface — the trail
// rows, the footer, the status line, the activity feed — reads them from THIS
// map, so no component hardcodes `jev`. A second provider is one more entry.
//
// The label matches the Settings catalog (`DECISION_PROVIDER_CATALOG`,
// apps/web-api services/decision-catalog.ts), which the Settings page reads
// over RPC; chat renders from the event stream alone, so it keeps its own copy
// of the two display strings here.

export interface DecisionProviderIdentity {
  /** `DecisionEvent.provider` — the catalog id the wire carries. */
  id: string;
  /** Display name used in sentences (`Jev paused after repeated failures`). */
  label: string;
  /** The short mono tag a row draws beside its state. */
  tag: string;
}

export const DECISION_PROVIDER_IDENTITIES: Record<string, DecisionProviderIdentity> = {
  typesafe: { id: 'typesafe', label: 'Jev', tag: 'jev' },
};

/**
 * Resolve a provider id off the wire. An id this build does not know is a newer
 * provider on the other side of the stream, not an error: it renders under its
 * own id rather than blanking the row.
 */
export function resolveDecisionProvider(id: string): DecisionProviderIdentity {
  const known = DECISION_PROVIDER_IDENTITIES[id];
  if (known) return known;
  const trimmed = id.trim() || 'decision';
  return {
    id: trimmed,
    label: trimmed.charAt(0).toUpperCase() + trimmed.slice(1),
    tag: trimmed.toLowerCase(),
  };
}

/**
 * DESIGN.md's `decision` token: the runner-teal values (the hex lives only in
 * `lib/runners.ts`). It is not an `--accent` — the personality's hue stays the
 * personality's. Stamped once on `:root` as `--decision` by `main.tsx`, per skin.
 */
export const DECISION_ACCENT: RunnerAccent = RUNNER_TEAL;

export function decisionAccentCss(light: boolean): string {
  return light ? DECISION_ACCENT.light : DECISION_ACCENT.dark;
}
